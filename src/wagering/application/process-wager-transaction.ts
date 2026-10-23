import { randomUUID } from "node:crypto";
import { OutboxMessage } from "../../outbox/domain/outbox-message";
import { Money, type MoneyProps } from "../../shared/domain/money";
import { WagerTransactionProcessed } from "../domain/integration-events/wager-transaction-processed";
import { WagerTransactionPendingReference } from "../domain/integration-events/wager-transaction-pending-reference";
import { WagerTransactionRejected } from "../domain/integration-events/wager-transaction-rejected";
import { WalletBalanceChanged } from "../../wallet/domain/integration-events/wallet-balance-changed";
import {
  InsufficientFundsError,
  type WalletBalanceChange,
  type Wallet,
} from "../../wallet/domain/wallet";
import { WalletLedgerEntry } from "../../wallet/domain/wallet-ledger-entry";
import { hashWagerTransactionBusinessPayload } from "./canonical-business-payload";
import { WagerTransaction } from "../domain/wager-transaction";
import { WagerTransactionRejectionCode } from "../domain/wager-transaction-failure-code";
import { WagerTransactionKind as TransactionKind } from "../domain/wager-transaction-kind";
import type { WagerTransactionKind } from "../domain/wager-transaction-kind";
import { WagerTransactionStatus } from "../domain/wager-transaction-status";
import type {
  WageringMetricsPort,
  WageringTransport,
} from "../../shared/application/observability";

export type WagerReplaySource = "idempotency" | "provider_identity" | null;

export class InvalidWagerProcessingRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidWagerProcessingRequestError";
  }
}

export class UnsupportedWagerTransactionKindError extends Error {
  constructor(kind: WagerTransactionKind) {
    super(`Wager transaction kind ${kind} is not supported in this phase`);
    this.name = "UnsupportedWagerTransactionKindError";
  }
}

export class IdempotencyConflictError extends Error {
  constructor() {
    super("Idempotency key was already used with a different business payload");
    this.name = "IdempotencyConflictError";
  }
}

export class WagerWalletNotFoundError extends Error {
  constructor(walletId: string) {
    super(`Wallet ${walletId} was not found`);
    this.name = "WagerWalletNotFoundError";
  }
}

export class WagerPlayerMismatchError extends Error {
  constructor() {
    super("Wallet does not belong to the requested player");
    this.name = "WagerPlayerMismatchError";
  }
}

export class WagerCurrencyMismatchError extends Error {
  constructor() {
    super("Wallet currency does not match transaction currency");
    this.name = "WagerCurrencyMismatchError";
  }
}

export class ProviderTransactionConflictError extends Error {
  constructor() {
    super(
      "Provider transaction already exists with different idempotency data",
    );
    this.name = "ProviderTransactionConflictError";
  }
}

export interface ProcessWagerTransactionInput {
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  referenceExternalTransactionId?: string | null;
}

export interface WagerTransactionProcessingArtifacts {
  transaction: WagerTransaction;
  updatedWallet: Wallet | null;
  ledgerEntry: WalletLedgerEntry | null;
  outboxMessages: readonly OutboxMessage[];
}

export interface WagerTransactionProcessingContext {
  wallet: Wallet;
  findReferenceTransaction(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | null>;
  hasProcessedReversal(
    referenceTransactionId: string,
    kind: TransactionKind.REFUND | TransactionKind.ROLLBACK,
  ): Promise<boolean>;
}

export interface WagerTransactionProcessingStore {
  executeIdempotently(
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
    transaction: WagerTransaction;
    idempotentReplay: boolean;
    inboxDuplicate?: boolean;
    replaySource?: WagerReplaySource;
  }>;
}

export interface InboxProcessingMetadata {
  consumerName: string;
  messageId: string;
  payloadHash: string;
  receivedAt: Date;
}

export class InboxMessageConflictError extends Error {
  constructor() {
    super("Inbox message id was received with a different payload");
    this.name = "InboxMessageConflictError";
  }
}

export class InboxProcessingStateError extends Error {
  constructor() {
    super("Inbox message has an incomplete persisted processing state");
    this.name = "InboxProcessingStateError";
  }
}

export interface ProcessWagerTransactionResult {
  transactionId: string;
  status: WagerTransactionStatus;
  failureCode: WagerTransaction["failureCode"];
  walletId: string;
  resultingBalance: MoneyProps | null;
  idempotentReplay: boolean;
}

function isSupportedKind(
  kind: WagerTransactionKind,
): kind is Exclude<WagerTransactionKind, TransactionKind.OPENING> {
  return (
    kind === TransactionKind.BET ||
    kind === TransactionKind.WIN ||
    kind === TransactionKind.LOSS ||
    kind === TransactionKind.REFUND ||
    kind === TransactionKind.ROLLBACK
  );
}

type ReferenceValidation =
  | { kind: "pending" }
  | { kind: "rejected"; failureCode: WagerTransactionRejectionCode }
  | null;

function validateReference(
  input: ProcessWagerTransactionInput,
  transaction: WagerTransaction,
  reference: WagerTransaction,
): ReferenceValidation {
  if (reference.providerId !== input.providerId) {
    return {
      kind: "rejected",
      failureCode: WagerTransactionRejectionCode.REFERENCE_PROVIDER_MISMATCH,
    };
  }
  if (reference.playerId !== input.playerId) {
    return {
      kind: "rejected",
      failureCode: WagerTransactionRejectionCode.REFERENCE_PLAYER_MISMATCH,
    };
  }
  if (reference.walletId !== input.walletId) {
    return {
      kind: "rejected",
      failureCode: WagerTransactionRejectionCode.REFERENCE_WALLET_MISMATCH,
    };
  }
  if (reference.money.currency !== transaction.money.currency) {
    return {
      kind: "rejected",
      failureCode: WagerTransactionRejectionCode.REFERENCE_CURRENCY_MISMATCH,
    };
  }
  if (reference.roundId !== transaction.roundId) {
    return {
      kind: "rejected",
      failureCode: WagerTransactionRejectionCode.REFERENCE_ROUND_MISMATCH,
    };
  }

  if (
    transaction.kind === TransactionKind.REFUND &&
    (reference.kind !== TransactionKind.BET ||
      reference.status !== WagerTransactionStatus.PROCESSED)
  ) {
    return {
      kind: "rejected",
      failureCode: WagerTransactionRejectionCode.INVALID_REFERENCE_KIND,
    };
  }
  if (
    transaction.kind === TransactionKind.ROLLBACK &&
    (reference.status !== WagerTransactionStatus.PROCESSED ||
      (reference.kind !== TransactionKind.BET &&
        reference.kind !== TransactionKind.WIN &&
        reference.kind !== TransactionKind.REFUND))
  ) {
    return {
      kind: "rejected",
      failureCode: WagerTransactionRejectionCode.INVALID_REFERENCE_KIND,
    };
  }
  if (transaction.kind === TransactionKind.WIN) {
    if (reference.kind !== TransactionKind.BET) {
      return {
        kind: "rejected",
        failureCode: WagerTransactionRejectionCode.INVALID_REFERENCE_KIND,
      };
    }
    if (
      reference.status === WagerTransactionStatus.PENDING ||
      reference.status === WagerTransactionStatus.PENDING_REFERENCE
    ) {
      return { kind: "pending" };
    }
    if (reference.status !== WagerTransactionStatus.PROCESSED) {
      return {
        kind: "rejected",
        failureCode: WagerTransactionRejectionCode.REFERENCE_NOT_PROCESSED,
      };
    }
  }
  if (
    (transaction.kind === TransactionKind.REFUND ||
      transaction.kind === TransactionKind.ROLLBACK) &&
    !transaction.money.equals(reference.money)
  ) {
    return {
      kind: "rejected",
      failureCode: WagerTransactionRejectionCode.REFERENCE_AMOUNT_MISMATCH,
    };
  }
  return null;
}

function requireIdentifier(value: string, field: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new InvalidWagerProcessingRequestError(`${field} must not be empty`);
  }
}

export class ProcessWagerTransaction {
  constructor(
    private readonly store: WagerTransactionProcessingStore,
    private readonly metrics?: WageringMetricsPort,
  ) {}

  async execute(
    input: ProcessWagerTransactionInput,
    transport: WageringTransport = "http",
  ): Promise<ProcessWagerTransactionResult> {
    return (await this.executeInternal(input, undefined, transport)).result;
  }

  async executeFromInbox(
    input: ProcessWagerTransactionInput,
    inbox: InboxProcessingMetadata,
    transport: WageringTransport = "sqs",
  ): Promise<{
    result: ProcessWagerTransactionResult;
    inboxDuplicate: boolean;
  }> {
    return this.executeInternal(input, inbox, transport);
  }

  private async executeInternal(
    input: ProcessWagerTransactionInput,
    inbox?: InboxProcessingMetadata,
    transport: WageringTransport = "http",
  ): Promise<{
    result: ProcessWagerTransactionResult;
    inboxDuplicate: boolean;
  }> {
    if (!isSupportedKind(input.kind)) {
      throw new UnsupportedWagerTransactionKindError(input.kind);
    }
    const kind = input.kind;
    for (const [field, value] of Object.entries({
      idempotencyKey: input.idempotencyKey,
      providerId: input.providerId,
      externalTransactionId: input.externalTransactionId,
    })) {
      requireIdentifier(value, field);
    }
    if (
      (kind === TransactionKind.BET || kind === TransactionKind.LOSS) &&
      input.referenceExternalTransactionId != null
    ) {
      throw new InvalidWagerProcessingRequestError(
        `${kind} must not contain an external reference`,
      );
    }

    const money = Money.from(input.money);
    if (
      (kind === TransactionKind.BET || kind === TransactionKind.WIN) &&
      !money.isPositive()
    ) {
      throw new InvalidWagerProcessingRequestError(
        `${kind} amount must be strictly positive`,
      );
    }

    const payloadHash = hashWagerTransactionBusinessPayload({
      providerId: input.providerId,
      externalTransactionId: input.externalTransactionId,
      playerId: input.playerId,
      walletId: input.walletId,
      roundId: input.roundId,
      gameId: input.gameId,
      kind,
      money: input.money,
      referenceExternalTransactionId: input.referenceExternalTransactionId,
    });
    const stored = await this.store.executeIdempotently(
      {
        idempotencyKey: input.idempotencyKey,
        payloadHash,
        walletId: input.walletId,
        providerId: input.providerId,
        externalTransactionId: input.externalTransactionId,
      },
      async (context) => {
        const { wallet } = context;
        if (wallet.playerId !== input.playerId) {
          throw new WagerPlayerMismatchError();
        }
        if (wallet.currency !== money.currency) {
          throw new WagerCurrencyMismatchError();
        }

        const now = new Date();
        const transaction = WagerTransaction.create(
          {
            id: randomUUID(),
            providerId: input.providerId,
            externalTransactionId: input.externalTransactionId,
            idempotencyKey: input.idempotencyKey,
            payloadHash,
            walletId: input.walletId,
            playerId: input.playerId,
            roundId: input.roundId,
            gameId: input.gameId,
            kind,
            money,
            ...(input.referenceExternalTransactionId === undefined
              ? {}
              : {
                  referenceExternalTransactionId:
                    input.referenceExternalTransactionId,
                }),
          },
          now,
        );

        const artifacts = await this.processExisting(
          input,
          transaction,
          context,
          now,
          false,
        );
        if (artifacts === null) {
          throw new Error("A new transaction cannot defer recovery scheduling");
        }
        return artifacts;
      },
      inbox,
    );

    if (stored.idempotentReplay) {
      if (stored.replaySource !== undefined && stored.replaySource !== null) {
        this.metrics?.recordDuplicate(stored.replaySource);
      }
    } else {
      this.metrics?.recordTransaction(
        stored.transaction.status,
        stored.transaction.kind,
        transport,
      );
    }
    if (stored.inboxDuplicate) this.metrics?.recordDuplicate("inbox");

    return {
      result: {
        transactionId: stored.transaction.id,
        status: stored.transaction.status,
        failureCode: stored.transaction.failureCode,
        walletId: stored.transaction.walletId,
        resultingBalance: stored.transaction.resultingBalance?.toJSON() ?? null,
        idempotentReplay: stored.idempotentReplay,
      },
      inboxDuplicate: stored.inboxDuplicate ?? false,
    };
  }

  async resumePendingReference(
    transaction: WagerTransaction,
    context: WagerTransactionProcessingContext,
    now: Date,
    nextAttempt: number,
    maxAttempts: number,
  ): Promise<WagerTransactionProcessingArtifacts | null> {
    if (
      transaction.status !== WagerTransactionStatus.PENDING_REFERENCE ||
      transaction.providerId === null ||
      transaction.externalTransactionId === null ||
      transaction.roundId === null ||
      transaction.gameId === null
    ) {
      throw new Error(
        "Only provider transactions awaiting a reference can resume",
      );
    }
    const input: ProcessWagerTransactionInput = {
      providerId: transaction.providerId,
      externalTransactionId: transaction.externalTransactionId,
      idempotencyKey: transaction.idempotencyKey,
      playerId: transaction.playerId,
      walletId: transaction.walletId,
      roundId: transaction.roundId,
      gameId: transaction.gameId,
      kind: transaction.kind,
      money: transaction.money.toJSON(),
      referenceExternalTransactionId:
        transaction.referenceExternalTransactionId,
    };
    const providerId = transaction.providerId;
    const referenceExternalTransactionId =
      transaction.referenceExternalTransactionId;
    if (providerId === null || referenceExternalTransactionId === null) {
      throw new Error("Pending reference identity is incomplete");
    }
    const reference = await context.findReferenceTransaction(
      providerId,
      referenceExternalTransactionId,
    );
    const artifacts = await this.processExisting(
      input,
      transaction,
      context,
      now,
      true,
    );
    if (artifacts !== null || reference !== null || nextAttempt < maxAttempts) {
      return artifacts;
    }

    const transitionAt = new Date(
      Math.max(now.getTime(), transaction.updatedAt.getTime()),
    );
    transaction.reject(
      WagerTransactionRejectionCode.REFERENCE_NOT_FOUND,
      transitionAt,
    );
    return this.rejectedArtifacts(transaction);
  }

  private async processExisting(
    input: ProcessWagerTransactionInput,
    transaction: WagerTransaction,
    context: WagerTransactionProcessingContext,
    now: Date,
    recovery: boolean,
  ): Promise<WagerTransactionProcessingArtifacts | null> {
    const { wallet } = context;
    if (wallet.playerId !== transaction.playerId) {
      throw new WagerPlayerMismatchError();
    }
    if (wallet.currency !== transaction.money.currency) {
      throw new WagerCurrencyMismatchError();
    }

    let referenceTransaction: WagerTransaction | null = null;
    if (transaction.referenceExternalTransactionId !== null) {
      const providerId = transaction.providerId;
      if (providerId === null) {
        throw new Error("Provider reference resolution requires a provider id");
      }
      referenceTransaction = await context.findReferenceTransaction(
        providerId,
        transaction.referenceExternalTransactionId,
      );
      if (referenceTransaction === null) {
        if (recovery) return null;
        transaction.markPendingReference(now);
        return this.pendingArtifacts(transaction);
      }

      const referenceValidation = validateReference(
        input,
        transaction,
        referenceTransaction,
      );
      if (referenceValidation?.kind === "pending") {
        return recovery ? null : this.markPending(transaction, now);
      }

      transaction.resolveReference(referenceTransaction.id, now);
      if (referenceValidation?.kind === "rejected") {
        transaction.reject(referenceValidation.failureCode, now);
        return this.rejectedArtifacts(transaction);
      }

      if (
        (transaction.kind === TransactionKind.REFUND ||
          transaction.kind === TransactionKind.ROLLBACK) &&
        (await context.hasProcessedReversal(
          referenceTransaction.id,
          transaction.kind,
        ))
      ) {
        transaction.reject(
          transaction.kind === TransactionKind.REFUND
            ? WagerTransactionRejectionCode.ALREADY_REFUNDED
            : WagerTransactionRejectionCode.ALREADY_ROLLED_BACK,
          now,
        );
        return this.rejectedArtifacts(transaction);
      }
    }

    if (transaction.kind === TransactionKind.LOSS) {
      transaction.markProcessed(wallet.balance, now);
      const event = WagerTransactionProcessed.fromTransaction(
        randomUUID(),
        transaction,
      );
      return {
        transaction,
        updatedWallet: null,
        ledgerEntry: null,
        outboxMessages: [OutboxMessage.fromEvent(event)],
      };
    }

    let change: WalletBalanceChange;
    try {
      if (transaction.kind === TransactionKind.BET) {
        change = wallet.debit(transaction.money, now);
      } else if (
        transaction.kind === TransactionKind.WIN ||
        transaction.kind === TransactionKind.REFUND
      ) {
        change = wallet.credit(transaction.money, now);
      } else if (transaction.kind === TransactionKind.ROLLBACK) {
        if (referenceTransaction === null) {
          throw new Error(
            "Rollback reference must be resolved before processing",
          );
        }
        change =
          referenceTransaction.kind === TransactionKind.BET
            ? wallet.credit(transaction.money, now)
            : wallet.debit(transaction.money, now);
      } else {
        throw new UnsupportedWagerTransactionKindError(transaction.kind);
      }
    } catch (error) {
      if (!(error instanceof InsufficientFundsError)) throw error;
      transaction.reject(
        transaction.kind === TransactionKind.BET
          ? WagerTransactionRejectionCode.INSUFFICIENT_FUNDS
          : WagerTransactionRejectionCode.REVERSAL_WOULD_CAUSE_NEGATIVE_BALANCE,
        now,
      );
      return this.rejectedArtifacts(transaction);
    }

    transaction.markProcessed(change.balanceAfter, now);
    const ledgerEntry = WalletLedgerEntry.create(
      {
        id: randomUUID(),
        walletId: wallet.id,
        transactionId: transaction.id,
        direction: change.direction,
        money: change.amount,
        balanceBefore: change.balanceBefore,
        balanceAfter: change.balanceAfter,
      },
      now,
    );
    const processedEvent = WagerTransactionProcessed.fromTransaction(
      randomUUID(),
      transaction,
    );
    const balanceEvent = WalletBalanceChanged.create({
      id: randomUUID(),
      walletId: wallet.id,
      playerId: wallet.playerId,
      direction: change.direction,
      money: change.amount,
      balanceBefore: change.balanceBefore,
      balanceAfter: change.balanceAfter,
      transactionId: transaction.id,
      occurredAt: now,
    });
    return {
      transaction,
      updatedWallet: wallet,
      ledgerEntry,
      outboxMessages: [
        OutboxMessage.fromEvent(processedEvent),
        OutboxMessage.fromEvent(balanceEvent),
      ],
    };
  }

  private markPending(
    transaction: WagerTransaction,
    now: Date,
  ): WagerTransactionProcessingArtifacts {
    transaction.markPendingReference(now);
    return this.pendingArtifacts(transaction);
  }

  private pendingArtifacts(
    transaction: WagerTransaction,
  ): WagerTransactionProcessingArtifacts {
    const event = WagerTransactionPendingReference.fromTransaction(
      randomUUID(),
      transaction,
    );
    return {
      transaction,
      updatedWallet: null,
      ledgerEntry: null,
      outboxMessages: [OutboxMessage.fromEvent(event)],
    };
  }

  private rejectedArtifacts(
    transaction: WagerTransaction,
  ): WagerTransactionProcessingArtifacts {
    const event = WagerTransactionRejected.fromTransaction(
      randomUUID(),
      transaction,
    );
    return {
      transaction,
      updatedWallet: null,
      ledgerEntry: null,
      outboxMessages: [OutboxMessage.fromEvent(event)],
    };
  }
}
