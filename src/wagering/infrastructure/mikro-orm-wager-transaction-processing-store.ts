import {
  type EntityManager,
  LockMode,
  UniqueConstraintViolationException,
} from "@mikro-orm/core";
import { MikroORM } from "@mikro-orm/postgresql";
import { Inject, Injectable, Optional } from "@nestjs/common";
import {
  outboxMessageToRecord,
  wagerTransactionFromRecord,
  wagerTransactionToRecord,
  walletFromRecord,
  walletLedgerEntryToRecord,
} from "../../infrastructure/database/domain-mappers";
import {
  InboxMessageRecord,
  WagerTransactionRecord,
  WalletRecord,
} from "../../infrastructure/database/entities";
import { nextReferenceAttemptAt } from "../application/reference-retry-policy";
import type { PendingReferenceRecoveryStore } from "../application/recover-pending-references";
import type {
  OutboxMessageRecord,
  WalletLedgerEntryRecord,
} from "../../infrastructure/database/entities";
import {
  IdempotencyConflictError,
  InboxMessageConflictError,
  InboxProcessingStateError,
  ProviderTransactionConflictError,
  WagerWalletNotFoundError,
  type WagerTransactionProcessingArtifacts,
  type WagerTransactionProcessingContext,
  type WagerTransactionProcessingStore,
  type InboxProcessingMetadata,
  type WagerReplaySource,
} from "../application/process-wager-transaction";
import { WagerTransactionStatus } from "../domain/wager-transaction-status";
import {
  isPostgresConcurrencyConflict,
  isTransientPostgresFailure,
} from "../../infrastructure/database/transient-postgres-failure";
import { InfrastructureUnavailableError } from "../../shared/application/infrastructure-unavailable-error";
import { WageringMetrics } from "../../infrastructure/metrics/wagering-metrics";

function violatesConstraint(error: Error, constraint: string): boolean {
  return "constraint" in error && error.constraint === constraint;
}

@Injectable()
export class MikroOrmWagerTransactionProcessingStore
  implements WagerTransactionProcessingStore, PendingReferenceRecoveryStore
{
  constructor(
    @Inject(MikroORM) private readonly orm: MikroORM,
    @Optional()
    @Inject(WageringMetrics)
    private readonly metrics?: WageringMetrics,
  ) {}

  private async insertInbox(
    em: EntityManager,
    inbox: InboxProcessingMetadata,
  ): Promise<boolean> {
    const rows = (await em.getConnection().execute(
      `insert into inbox_messages
         (consumer_name, message_id, payload_hash, received_at, processed_at)
       values (?, ?, ?, ?, null)
       on conflict (consumer_name, message_id) do nothing
       returning message_id`,
      [
        inbox.consumerName,
        inbox.messageId,
        inbox.payloadHash,
        inbox.receivedAt,
      ],
      "all",
      em.getTransactionContext(),
    )) as Array<{ message_id: string }>;
    return rows.length === 1;
  }

  private async markInboxProcessed(
    em: EntityManager,
    inbox: InboxProcessingMetadata,
  ): Promise<void> {
    const processedAt = new Date(
      Math.max(Date.now(), inbox.receivedAt.getTime()),
    );
    await em.getConnection().execute(
      `update inbox_messages
       set processed_at = ?
       where consumer_name = ? and message_id = ? and processed_at is null`,
      [processedAt, inbox.consumerName, inbox.messageId],
      "run",
      em.getTransactionContext(),
    );
  }

  private async resolveInboxIdentityRace(
    identity: {
      idempotencyKey: string;
      payloadHash: string;
      walletId: string;
      providerId: string;
      externalTransactionId: string;
    },
    inbox: InboxProcessingMetadata,
    identityKind: "idempotency" | "provider",
    originalError: Error,
  ): Promise<{
    transaction: ReturnType<typeof wagerTransactionFromRecord>;
    idempotentReplay: boolean;
    inboxDuplicate: boolean;
    replaySource: WagerReplaySource;
  }> {
    const em = this.orm.em.fork({ clear: true });
    try {
      return await em.transactional(async (transactionalEm) => {
        const inserted = await this.insertInbox(transactionalEm, inbox);
        if (!inserted) {
          const existingInbox = await transactionalEm.findOne(
            InboxMessageRecord,
            { consumerName: inbox.consumerName, messageId: inbox.messageId },
          );
          if (existingInbox === null || existingInbox.processedAt === null) {
            throw new InboxProcessingStateError();
          }
          if (existingInbox.payloadHash !== inbox.payloadHash) {
            throw new InboxMessageConflictError();
          }
          const existingTransaction =
            (await transactionalEm.findOne(WagerTransactionRecord, {
              idempotencyKey: identity.idempotencyKey,
            })) ??
            (await transactionalEm.findOne(WagerTransactionRecord, {
              providerId: identity.providerId,
              externalTransactionId: identity.externalTransactionId,
            }));
          if (existingTransaction === null) {
            throw new InboxProcessingStateError();
          }
          return {
            ...this.replayOrConflict(existingTransaction, identity.payloadHash),
            inboxDuplicate: true,
            replaySource:
              existingTransaction.idempotencyKey === identity.idempotencyKey
                ? "idempotency"
                : "provider_identity",
          };
        }

        const existing =
          identityKind === "idempotency"
            ? await transactionalEm.findOne(WagerTransactionRecord, {
                idempotencyKey: identity.idempotencyKey,
              })
            : await transactionalEm.findOne(WagerTransactionRecord, {
                providerId: identity.providerId,
                externalTransactionId: identity.externalTransactionId,
              });
        if (existing === null) throw originalError;
        const replay =
          identityKind === "idempotency"
            ? this.replayOrConflict(existing, identity.payloadHash)
            : this.providerReplayOrConflict(existing, identity.payloadHash);
        await this.markInboxProcessed(transactionalEm, inbox);
        return {
          ...replay,
          inboxDuplicate: false,
          replaySource:
            identityKind === "provider" ? "provider_identity" : "idempotency",
        };
      });
    } finally {
      em.clear();
    }
  }

  async recoverDue(
    options: {
      now: Date;
      baseDelayMs: number;
      maxAttempts: number;
      batchSize: number;
    },
    resume: Parameters<PendingReferenceRecoveryStore["recoverDue"]>[1],
  ): Promise<number> {
    if (
      !Number.isSafeInteger(options.batchSize) ||
      options.batchSize < 1 ||
      !Number.isSafeInteger(options.maxAttempts) ||
      options.maxAttempts < 1 ||
      options.maxAttempts > 20
    ) {
      throw new RangeError("Reference recovery batch policy is invalid");
    }

    let recovered = 0;
    while (recovered < options.batchSize) {
      const em = this.orm.em.fork({ clear: true });
      let found = false;
      try {
        await em.transactional(async (transactionalEm) => {
          const candidates = (await transactionalEm.getConnection().execute(
            `select id from wager_transactions
             where status = 'PENDING_REFERENCE'
               and kind in ('WIN', 'REFUND', 'ROLLBACK')
               and reference_next_attempt_at <= ?
             order by reference_next_attempt_at, created_at, id
             for update skip locked
             limit 1`,
            [options.now],
            "all",
            transactionalEm.getTransactionContext(),
          )) as Array<{ id: string }>;
          const candidate = candidates[0];
          if (candidate === undefined) return;
          found = true;

          const transactionRecord = await transactionalEm.findOneOrFail(
            WagerTransactionRecord,
            candidate.id,
          );
          const transaction = wagerTransactionFromRecord(transactionRecord);
          const walletRecord = await transactionalEm.findOne(
            WalletRecord,
            { id: transaction.walletId },
            { lockMode: LockMode.PESSIMISTIC_WRITE },
          );
          if (walletRecord === null) {
            throw new WagerWalletNotFoundError(transaction.walletId);
          }
          if (
            transactionRecord.status !==
              WagerTransactionStatus.PENDING_REFERENCE ||
            transactionRecord.referenceNextAttemptAt === null ||
            transactionRecord.referenceNextAttemptAt.getTime() >
              options.now.getTime()
          ) {
            return;
          }
          const context: WagerTransactionProcessingContext = {
            wallet: walletFromRecord(walletRecord),
            findReferenceTransaction: async (
              providerId,
              externalTransactionId,
            ) => {
              const referenceRecord = await transactionalEm.findOne(
                WagerTransactionRecord,
                { providerId, externalTransactionId },
              );
              return referenceRecord === null
                ? null
                : wagerTransactionFromRecord(referenceRecord);
            },
            hasProcessedReversal: async (referenceTransactionId, kind) =>
              (await transactionalEm.findOne(WagerTransactionRecord, {
                referenceTransactionId,
                kind,
                status: WagerTransactionStatus.PROCESSED,
              })) !== null,
          };

          const nextAttempt = transactionRecord.referenceRetryAttempts + 1;
          const artifacts = await resume(transaction, context, nextAttempt);
          if (artifacts === null) {
            transactionRecord.referenceRetryAttempts = nextAttempt;
            transactionRecord.referenceNextAttemptAt = nextReferenceAttemptAt(
              options.now,
              Math.min(nextAttempt, options.maxAttempts),
              options.baseDelayMs,
            );
            await transactionalEm.flush();
            return;
          }

          const persistedTransaction = wagerTransactionToRecord(
            artifacts.transaction,
          );
          Object.assign(transactionRecord, persistedTransaction, {
            referenceRetryAttempts: nextAttempt,
            referenceNextAttemptAt: null,
          });
          if (artifacts.updatedWallet !== null) {
            const updatedWallet = artifacts.updatedWallet;
            if (
              updatedWallet.id !== walletRecord.id ||
              updatedWallet.playerId !== walletRecord.playerId ||
              updatedWallet.currency !== walletRecord.currency
            ) {
              throw new Error(
                "Updated wallet identity cannot change during reference recovery",
              );
            }
            walletRecord.balance = updatedWallet.balance.toJSON().amount;
            walletRecord.version = updatedWallet.version;
            walletRecord.updatedAt = updatedWallet.updatedAt;
          }

          const records: (WalletLedgerEntryRecord | OutboxMessageRecord)[] = [
            ...(artifacts.ledgerEntry === null
              ? []
              : [walletLedgerEntryToRecord(artifacts.ledgerEntry)]),
            ...artifacts.outboxMessages.map(outboxMessageToRecord),
          ];
          transactionalEm.persist(records);
          await transactionalEm.flush();
        });
      } catch (error) {
        if (isPostgresConcurrencyConflict(error)) {
          this.metrics?.recordLockConflict("reference_recovery");
        }
        throw error;
      } finally {
        em.clear();
      }
      if (!found) break;
      recovered += 1;
    }
    return recovered;
  }

  async executeIdempotently(
    identity: {
      idempotencyKey: string;
      payloadHash: string;
      walletId: string;
      providerId: string;
      externalTransactionId: string;
    },
    createArtifacts: (
      context: WagerTransactionProcessingContext,
    ) => Promise<WagerTransactionProcessingArtifacts>,
    inbox?: InboxProcessingMetadata,
  ): Promise<{
    transaction: ReturnType<typeof wagerTransactionFromRecord>;
    idempotentReplay: boolean;
    inboxDuplicate: boolean;
    replaySource: WagerReplaySource;
  }> {
    const em = this.orm.em.fork({ clear: true });
    try {
      return await em.transactional(async (transactionalEm) => {
        if (inbox !== undefined) {
          const insertedInbox = await this.insertInbox(transactionalEm, inbox);
          if (!insertedInbox) {
            const existingInbox = await transactionalEm.findOne(
              InboxMessageRecord,
              { consumerName: inbox.consumerName, messageId: inbox.messageId },
            );
            if (existingInbox === null || existingInbox.processedAt === null) {
              throw new InboxProcessingStateError();
            }
            if (existingInbox.payloadHash !== inbox.payloadHash) {
              throw new InboxMessageConflictError();
            }
            const existingTransaction =
              (await transactionalEm.findOne(WagerTransactionRecord, {
                idempotencyKey: identity.idempotencyKey,
              })) ??
              (await transactionalEm.findOne(WagerTransactionRecord, {
                providerId: identity.providerId,
                externalTransactionId: identity.externalTransactionId,
              }));
            if (existingTransaction === null) {
              throw new InboxProcessingStateError();
            }
            const replay = this.replayOrConflict(
              existingTransaction,
              identity.payloadHash,
            );
            return {
              ...replay,
              inboxDuplicate: true,
              replaySource:
                existingTransaction.idempotencyKey === identity.idempotencyKey
                  ? "idempotency"
                  : "provider_identity",
            };
          }
        }

        const finishReplay = async (
          record: WagerTransactionRecord,
          providerIdentity = false,
        ) => {
          const replay = providerIdentity
            ? this.providerReplayOrConflict(record, identity.payloadHash)
            : this.replayOrConflict(record, identity.payloadHash);
          if (inbox !== undefined) {
            await this.markInboxProcessed(transactionalEm, inbox);
          }
          return {
            ...replay,
            inboxDuplicate: false,
            replaySource: providerIdentity
              ? ("provider_identity" as const)
              : ("idempotency" as const),
          };
        };

        const existing = await transactionalEm.findOne(WagerTransactionRecord, {
          idempotencyKey: identity.idempotencyKey,
        });
        if (existing !== null) {
          return finishReplay(existing);
        }

        const existingProviderTransaction = await transactionalEm.findOne(
          WagerTransactionRecord,
          {
            providerId: identity.providerId,
            externalTransactionId: identity.externalTransactionId,
          },
        );
        if (existingProviderTransaction !== null) {
          return finishReplay(existingProviderTransaction, true);
        }

        const walletRecord = await transactionalEm.findOne(
          WalletRecord,
          { id: identity.walletId },
          { lockMode: LockMode.PESSIMISTIC_WRITE },
        );
        if (walletRecord === null) {
          throw new WagerWalletNotFoundError(identity.walletId);
        }

        // Recheck after acquiring the wallet lock: same-wallet requests serialize here.
        const raced = await transactionalEm.findOne(WagerTransactionRecord, {
          idempotencyKey: identity.idempotencyKey,
        });
        if (raced !== null) {
          return finishReplay(raced);
        }

        const racedProviderTransaction = await transactionalEm.findOne(
          WagerTransactionRecord,
          {
            providerId: identity.providerId,
            externalTransactionId: identity.externalTransactionId,
          },
        );
        if (racedProviderTransaction !== null) {
          return finishReplay(racedProviderTransaction, true);
        }

        const wallet = walletFromRecord(walletRecord);
        const artifacts = await createArtifacts({
          wallet,
          findReferenceTransaction: async (
            providerId,
            externalTransactionId,
          ) => {
            const referenceRecord = await transactionalEm.findOne(
              WagerTransactionRecord,
              { providerId, externalTransactionId },
            );
            return referenceRecord === null
              ? null
              : wagerTransactionFromRecord(referenceRecord);
          },
          hasProcessedReversal: async (referenceTransactionId, kind) => {
            const reversal = await transactionalEm.findOne(
              WagerTransactionRecord,
              {
                referenceTransactionId,
                kind,
                status: WagerTransactionStatus.PROCESSED,
              },
            );
            return reversal !== null;
          },
        });
        if (artifacts.transaction.walletId !== wallet.id) {
          throw new Error(
            "Processed transaction wallet does not match locked wallet",
          );
        }

        if (artifacts.updatedWallet !== null) {
          const updatedWallet = artifacts.updatedWallet;
          if (
            updatedWallet.id !== walletRecord.id ||
            updatedWallet.playerId !== walletRecord.playerId ||
            updatedWallet.currency !== walletRecord.currency
          ) {
            throw new Error(
              "Updated wallet identity cannot change during processing",
            );
          }
          walletRecord.balance = updatedWallet.balance.toJSON().amount;
          walletRecord.version = updatedWallet.version;
          walletRecord.updatedAt = updatedWallet.updatedAt;
        }

        await transactionalEm
          .persist(wagerTransactionToRecord(artifacts.transaction))
          .flush();

        const records: (WalletLedgerEntryRecord | OutboxMessageRecord)[] = [
          ...(artifacts.ledgerEntry === null
            ? []
            : [walletLedgerEntryToRecord(artifacts.ledgerEntry)]),
          ...artifacts.outboxMessages.map(outboxMessageToRecord),
        ];
        if (records.length > 0) {
          transactionalEm.persist(records);
          await transactionalEm.flush();
        }
        if (inbox !== undefined) {
          await this.markInboxProcessed(transactionalEm, inbox);
        }

        return {
          transaction: artifacts.transaction,
          idempotentReplay: false,
          inboxDuplicate: false,
          replaySource: null,
        };
      });
    } catch (error) {
      if (isPostgresConcurrencyConflict(error)) {
        this.metrics?.recordLockConflict("wager_processing");
      }
      if (
        error instanceof UniqueConstraintViolationException &&
        violatesConstraint(error, "wager_transactions_idempotency_key_unique")
      ) {
        if (inbox !== undefined) {
          return this.resolveInboxIdentityRace(
            identity,
            inbox,
            "idempotency",
            error,
          );
        }
        return this.resolveIdempotencyRace(
          identity.idempotencyKey,
          identity.payloadHash,
          error,
        );
      }
      if (
        error instanceof UniqueConstraintViolationException &&
        violatesConstraint(error, "wager_transactions_provider_external_unique")
      ) {
        if (inbox !== undefined) {
          return this.resolveInboxIdentityRace(
            identity,
            inbox,
            "provider",
            error,
          );
        }
        return this.resolveProviderTransactionRace(
          identity.providerId,
          identity.externalTransactionId,
          identity.payloadHash,
          error,
        );
      }
      if (isTransientPostgresFailure(error)) {
        throw new InfrastructureUnavailableError(
          "Wager transaction processing is temporarily unavailable",
        );
      }
      throw error;
    } finally {
      em.clear();
    }
  }

  private async resolveIdempotencyRace(
    idempotencyKey: string,
    payloadHash: string,
    originalError: Error,
  ): Promise<{
    transaction: ReturnType<typeof wagerTransactionFromRecord>;
    idempotentReplay: boolean;
    inboxDuplicate: boolean;
    replaySource: WagerReplaySource;
  }> {
    const readEm = this.orm.em.fork({ clear: true });
    try {
      const existing = await readEm.findOne(WagerTransactionRecord, {
        idempotencyKey,
      });
      if (existing === null) throw originalError;
      return {
        ...this.replayOrConflict(existing, payloadHash),
        inboxDuplicate: false,
        replaySource: "idempotency",
      };
    } finally {
      readEm.clear();
    }
  }

  private async resolveProviderTransactionRace(
    providerId: string,
    externalTransactionId: string,
    payloadHash: string,
    originalError: Error,
  ): Promise<{
    transaction: ReturnType<typeof wagerTransactionFromRecord>;
    idempotentReplay: boolean;
    inboxDuplicate: boolean;
    replaySource: WagerReplaySource;
  }> {
    // PostgreSQL's unique check waits for a competing INSERT; once it raises a
    // violation, the winning row is committed and visible to this fresh READ COMMITTED query.
    const readEm = this.orm.em.fork({ clear: true });
    try {
      const existing = await readEm.findOne(WagerTransactionRecord, {
        providerId,
        externalTransactionId,
      });
      if (existing === null) throw originalError;
      return {
        ...this.providerReplayOrConflict(existing, payloadHash),
        inboxDuplicate: false,
        replaySource: "provider_identity",
      };
    } finally {
      readEm.clear();
    }
  }

  private replayOrConflict(
    record: WagerTransactionRecord,
    payloadHash: string,
  ): {
    transaction: ReturnType<typeof wagerTransactionFromRecord>;
    idempotentReplay: boolean;
  } {
    if (record.payloadHash !== payloadHash) {
      throw new IdempotencyConflictError();
    }
    return {
      transaction: wagerTransactionFromRecord(record),
      idempotentReplay: true,
    };
  }

  private providerReplayOrConflict(
    record: WagerTransactionRecord,
    payloadHash: string,
  ): {
    transaction: ReturnType<typeof wagerTransactionFromRecord>;
    idempotentReplay: boolean;
  } {
    if (record.payloadHash !== payloadHash) {
      throw new ProviderTransactionConflictError();
    }
    return {
      transaction: wagerTransactionFromRecord(record),
      idempotentReplay: true,
    };
  }
}
