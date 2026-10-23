import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { MikroORM } from "@mikro-orm/postgresql";
import "reflect-metadata";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { unlink } from "node:fs/promises";
import {
  ChangeMessageVisibilityCommand,
  CreateQueueCommand,
  DeleteMessageCommand,
  DeleteQueueCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";
import { PinoLogger } from "nestjs-pino";
import { Registry } from "prom-client";
import { parseEnvironment } from "../src/infrastructure/config/environment";
import { databaseConfig } from "../src/infrastructure/database/database.config";
import {
  wagerTransactionFromRecord,
  wagerTransactionToRecord,
  walletFromRecord,
  walletLedgerEntryFromRecord,
  walletLedgerEntryToRecord,
  walletToRecord,
} from "../src/infrastructure/database/domain-mappers";
import {
  InboxMessageRecord,
  OutboxMessageRecord,
  WagerTransactionRecord,
  WalletLedgerEntryRecord,
  WalletRecord,
} from "../src/infrastructure/database/entities";
import { Money } from "../src/shared/domain/money";
import {
  CreateWallet,
  WalletAlreadyExistsError,
} from "../src/wallet/application/create-wallet";
import { MikroOrmWalletCreationStore } from "../src/wallet/infrastructure/mikro-orm-wallet-creation-store";
import { WalletsController } from "../src/wallet/wallets.controller";
import {
  ReadWallet,
  ReadWalletLedger,
} from "../src/wallet/application/read-wallet";
import { MikroOrmWalletReadStore } from "../src/wallet/infrastructure/mikro-orm-wallet-read-store";
import { MikroOrmWalletReconciliationStore } from "../src/wallet/infrastructure/mikro-orm-wallet-reconciliation-store";
import { ReconcileWallet } from "../src/wallet/application/reconcile-wallet";
import { WalletReconciliationController } from "../src/wallet/wallet-reconciliation.controller";
import { WageringMetrics } from "../src/infrastructure/metrics/wagering-metrics";
import { LedgerDirection } from "../src/wallet/domain/ledger-direction";
import { Wallet } from "../src/wallet/domain/wallet";
import { WalletLedgerEntry } from "../src/wallet/domain/wallet-ledger-entry";
import { WagerTransactionKind } from "../src/wagering/domain/wager-transaction-kind";
import { WagerTransaction } from "../src/wagering/domain/wager-transaction";
import {
  IdempotencyConflictError,
  ProcessWagerTransaction,
  ProviderTransactionConflictError,
  type WagerTransactionProcessingStore,
} from "../src/wagering/application/process-wager-transaction";
import { MikroOrmWagerTransactionProcessingStore } from "../src/wagering/infrastructure/mikro-orm-wager-transaction-processing-store";
import { WagerTransactionStatus } from "../src/wagering/domain/wager-transaction-status";
import { WagerTransactionRejectionCode } from "../src/wagering/domain/wager-transaction-failure-code";
import { RecoverPendingReferences } from "../src/wagering/application/recover-pending-references";
import { WageringTransactionsController } from "../src/wagering/wagering-transactions.controller";
import { ReadWagerTransaction } from "../src/wagering/application/read-wager-transaction";
import { MikroOrmWagerTransactionReadStore } from "../src/wagering/infrastructure/mikro-orm-wager-transaction-read-store";
import {
  ProviderWagerTransactionReadsController,
  WagerTransactionReadsController,
} from "../src/wagering/wager-transaction-reads.controller";
import { WagerTransactionSqsConsumer } from "../src/wagering/infrastructure/wager-transaction-sqs-consumer";
import { MikroOrmOutboxPublishingStore } from "../src/outbox/infrastructure/mikro-orm-outbox-publishing-store";
import { AwsSqsIntegrationEventQueue } from "../src/outbox/infrastructure/aws-sqs-integration-event-queue";
import {
  PublishOutboxMessages,
  type IntegrationEventQueue,
} from "../src/outbox/application/publish-outbox-messages";
import {
  parseWagerTransactionRequested,
  WAGER_TRANSACTION_REQUESTED_TYPE,
} from "../src/wagering/application/wager-transaction-requested";
import { assertGlobalFinancialConsistency } from "./helpers/global-financial-audit";

const enabled = process.env.RUN_POSTGRES_INTEGRATION === "1";
const sqsEnabled = process.env.RUN_SQS_INTEGRATION === "1";
const databaseName = `wagering_test_${randomUUID().replaceAll("-", "")}`;
const instant = new Date("2026-01-01T00:00:00.000Z");
let admin: MikroORM;
let orm: MikroORM;
let createdIntegrationDatabase = false;

async function removeOwnedMigrationSnapshot(ownedDatabaseName: string) {
  try {
    await unlink(
      `src/infrastructure/database/migrations/.snapshot-${ownedDatabaseName}.json`,
    );
  } catch (error) {
    if (
      !(error instanceof Error && "code" in error && error.code === "ENOENT")
    ) {
      throw error;
    }
  }
}

type AtomicFailurePoint = {
  name: string;
  table:
    | "wager_transactions"
    | "wallets"
    | "wallet_ledger_entries"
    | "outbox_messages"
    | "inbox_messages";
  timing: "immediate" | "deferred";
  match: "transaction" | "wallet" | "ledger" | "outbox" | "inbox";
};

async function installAtomicFailureTrigger(
  point: AtomicFailurePoint,
  walletId: string,
  messageId?: string,
): Promise<{
  triggerName: string;
  functionName: string;
  table: AtomicFailurePoint["table"];
}> {
  const suffix = randomUUID().replaceAll("-", "");
  const triggerName = `acceptance_fail_${suffix}`;
  const functionName = `acceptance_fail_fn_${suffix}`;
  const escapedWalletId = walletId.replaceAll("'", "''");
  const escapedMessageId = (messageId ?? "").replaceAll("'", "''");
  const condition =
    point.match === "wallet"
      ? `new.id = '${escapedWalletId}' and new.balance is distinct from old.balance`
      : point.match === "inbox"
        ? `new.message_id = '${escapedMessageId}' and new.consumer_name = 'wager-transaction-consumer.v1'`
        : point.match === "outbox"
          ? `new.aggregate_id = '${escapedWalletId}'`
          : `new.wallet_id = '${escapedWalletId}'`;
  const triggerKind =
    point.timing === "deferred" ? "constraint trigger" : "trigger";
  const deferClause =
    point.timing === "deferred" ? "deferrable initially deferred" : "";
  const whenClause = point.timing === "immediate" ? `when (${condition})` : "";
  const event = point.match === "wallet" ? "after update" : "after insert";
  await connection().execute(`
    create function ${functionName}() returns trigger language plpgsql as $$
    begin
      raise exception 'acceptance injected failure at ${point.name}' using errcode = 'P0001';
    end;
    $$
  `);
  await connection().execute(`
    create ${triggerKind} ${triggerName}
    ${event} on ${point.table}
    ${deferClause}
    for each row
    ${whenClause}
    execute function ${functionName}()
  `);
  return { triggerName, functionName, table: point.table };
}

async function removeAtomicFailureTrigger(names: {
  triggerName: string;
  functionName: string;
  table: AtomicFailurePoint["table"];
}) {
  await connection().execute(
    `drop trigger if exists ${names.triggerName} on ${names.table}`,
  );
  await connection().execute(`drop function if exists ${names.functionName}()`);
}

function connection() {
  return orm.em.getConnection();
}

async function financialRowCounts(playerId: string) {
  const rows = await connection().execute(
    `select
       (select count(*)::integer from wallets where player_id = ?) as wallets,
       (select count(*)::integer from wager_transactions where wallet_id in
         (select id from wallets where player_id = ?)) as transactions,
       (select count(*)::integer from wallet_ledger_entries where wallet_id in
         (select id from wallets where player_id = ?)) as ledger,
       (select count(*)::integer from outbox_messages where payload->>'playerId' = ?) as outbox`,
    [playerId, playerId, playerId, playerId],
  );
  return rows[0] as {
    wallets: number;
    transactions: number;
    ledger: number;
    outbox: number;
  };
}

async function reconstructedBalance(playerId: string) {
  const walletRows = await connection().execute(
    "select currency from wallets where player_id = ?",
    [playerId],
  );
  const currency = (walletRows[0] as { currency: string } | undefined)
    ?.currency;
  if (!currency)
    throw new Error("Wallet was not persisted for balance reconstruction");
  const rows = (await connection().execute(
    "select direction, amount from wallet_ledger_entries where wallet_id in (select id from wallets where player_id = ?)",
    [playerId],
  )) as Array<{ direction: string; amount: string }>;
  const balance = rows.reduce((current, row) => {
    const amount = Money.from({ amount: row.amount, currency });
    return row.direction === "CREDIT"
      ? current.add(amount)
      : current.subtract(amount);
  }, Money.zero(currency));
  return balance.toJSON();
}

async function reconstructedWalletBalance(walletId: string) {
  const walletRows = await connection().execute(
    "select currency from wallets where id = ?",
    [walletId],
  );
  const currency = (walletRows[0] as { currency: string } | undefined)
    ?.currency;
  if (!currency)
    throw new Error("Wallet was not persisted for balance reconstruction");
  const rows = (await connection().execute(
    "select direction, amount from wallet_ledger_entries where wallet_id = ?",
    [walletId],
  )) as Array<{ direction: string; amount: string }>;
  const balance = rows.reduce((current, row) => {
    const amount = Money.from({ amount: row.amount, currency });
    return row.direction === "CREDIT"
      ? current.add(amount)
      : current.subtract(amount);
  }, Money.zero(currency));
  return balance.toJSON();
}

async function createWallet(id: string, playerId = id): Promise<void> {
  await connection().execute(
    "insert into wallets (id, player_id, currency, balance, version, created_at, updated_at) values (?, ?, 'BRL', '100.00', 1, ?, ?)",
    [id, playerId, instant, instant],
  );
}

async function createFundedWallet(
  initialBalance: string,
  currency = "BRL",
  playerId?: string,
) {
  const selectedPlayerId = playerId ?? `processor-player-${randomUUID()}`;
  const wallet = await new CreateWallet(
    new MikroOrmWalletCreationStore(orm),
  ).execute({ playerId: selectedPlayerId, currency, initialBalance });
  return { playerId: selectedPlayerId, wallet };
}

function processor(metrics?: WageringMetrics) {
  return new ProcessWagerTransaction(
    new MikroOrmWagerTransactionProcessingStore(orm, metrics),
    metrics,
  );
}

function referenceRecovery(
  options: {
    baseDelayMs?: number;
    maxAttempts?: number;
    batchSize?: number;
  } = {},
) {
  const store = new MikroOrmWagerTransactionProcessingStore(orm);
  return new RecoverPendingReferences(
    store,
    new ProcessWagerTransaction(store),
    {
      baseDelayMs: options.baseDelayMs ?? 1000,
      maxAttempts: options.maxAttempts ?? 8,
      batchSize: options.batchSize ?? 50,
    },
  );
}

async function retryState(transactionId: string) {
  const rows = (await connection().execute(
    "select reference_retry_attempts, reference_next_attempt_at, status from wager_transactions where id = ?",
    [transactionId],
  )) as Array<{
    reference_retry_attempts: number;
    reference_next_attempt_at: Date | string | null;
    status: string;
  }>;
  const row = rows[0];
  return row === undefined
    ? undefined
    : {
        ...row,
        reference_next_attempt_at:
          row.reference_next_attempt_at === null
            ? null
            : new Date(row.reference_next_attempt_at),
      };
}

async function retryDueAt(transactionId: string): Promise<Date> {
  const state = await retryState(transactionId);
  if (!(state?.reference_next_attempt_at instanceof Date)) {
    throw new Error(`Transaction ${transactionId} is not scheduled for retry`);
  }
  return state.reference_next_attempt_at;
}

async function deferOtherPendingReferences(
  transactionIds: readonly string[],
): Promise<void> {
  if (transactionIds.length === 0) {
    throw new Error("At least one pending transaction must be selected");
  }
  const placeholders = transactionIds.map(() => "?").join(", ");
  await connection().execute(
    `update wager_transactions
     set reference_next_attempt_at = '2099-01-01T00:00:00.000Z'
     where status = 'PENDING_REFERENCE' and id not in (${placeholders})`,
    [...transactionIds],
  );
}

function processInput(
  wallet: Wallet,
  kind: WagerTransactionKind,
  amount: string,
  identity: string = randomUUID(),
  referenceExternalTransactionId?: string,
) {
  return {
    providerId: "integration-provider",
    externalTransactionId: `external-${identity}`,
    idempotencyKey: `idempotency-${identity}`,
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: "integration-round",
    gameId: "integration-game",
    kind,
    money: { amount, currency: wallet.currency },
    ...(referenceExternalTransactionId === undefined
      ? {}
      : { referenceExternalTransactionId }),
  };
}

async function readWallet(walletId: string) {
  const rows = (await connection().execute(
    "select balance, version from wallets where id = ?",
    [walletId],
  )) as Array<{ balance: string; version: string }>;
  return rows[0];
}

async function countsForPlayer(playerId: string) {
  return financialRowCounts(playerId);
}

async function outboxCountForTransaction(transactionId: string) {
  const rows = (await connection().execute(
    "select count(*)::integer as count from outbox_messages where payload->>'transactionId' = ?",
    [transactionId],
  )) as Array<{ count: number }>;
  return rows[0]?.count;
}

async function transactionById(transactionId: string) {
  return orm.em
    .fork({ clear: true })
    .findOneOrFail(WagerTransactionRecord, transactionId);
}

async function createTransaction(
  id: string,
  walletId: string,
  idempotencyKey = id,
  externalTransactionId = id,
  playerId = walletId,
  currency = "BRL",
): Promise<void> {
  await connection().execute(
    `insert into wager_transactions (
      id, provider_id, external_transaction_id, idempotency_key, payload_hash,
      wallet_id, player_id, round_id, game_id, kind, status, amount, currency,
      created_at, updated_at
    ) values (?, 'provider', ?, ?, 'hash', ?, ?, 'round', 'game',
      'BET', 'PENDING', '20.00', ?, ?, ?)`,
    [
      id,
      externalTransactionId,
      idempotencyKey,
      walletId,
      playerId,
      currency,
      instant,
      instant,
    ],
  );
}

async function createLedger(
  id: string,
  walletId: string,
  transactionId: string,
  direction = "CREDIT",
  amount = "20.00",
  balanceBefore = "100.00",
  balanceAfter = "120.00",
  currency = "BRL",
): Promise<void> {
  await connection().execute(
    `insert into wallet_ledger_entries (
      id, wallet_id, transaction_id, direction, amount, currency,
      balance_before, balance_after, created_at
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      walletId,
      transactionId,
      direction,
      amount,
      currency,
      balanceBefore,
      balanceAfter,
      instant,
    ],
  );
}

describe.skipIf(!enabled)("PostgreSQL persistence", () => {
  beforeAll(async () => {
    const config = databaseConfig(parseEnvironment(process.env));
    admin = await MikroORM.init(config);
    await admin.em.getConnection().execute(`create database "${databaseName}"`);
    createdIntegrationDatabase = true;
    orm = await MikroORM.init({ ...config, dbName: databaseName });
  });

  afterAll(async () => {
    try {
      if (orm) await orm.close(true);
    } finally {
      if (admin) {
        try {
          if (createdIntegrationDatabase) {
            await admin.em
              .getConnection()
              .execute(`drop database "${databaseName}"`);
            createdIntegrationDatabase = false;
            await removeOwnedMigrationSnapshot(databaseName);
          }
        } finally {
          await admin.close(true);
        }
      }
    }
  });

  test("migrates an empty database up, down and up again", async () => {
    const migrator = orm.getMigrator();
    await migrator.up();
    expect(
      await connection().execute("select to_regclass('wallets') as name"),
    ).toEqual([{ name: "wallets" }]);
    await migrator.down();
    expect(
      await connection().execute(
        "select to_regclass('outbox_messages_unpublished_age_idx') as name",
      ),
    ).toEqual([{ name: null }]);
    await migrator.down();
    expect(
      await connection().execute(
        "select to_regclass('wallet_ledger_entries_wallet_created_id_idx') as name",
      ),
    ).toEqual([{ name: null }]);
    await migrator.down();
    expect(
      await connection().execute(
        "select column_name from information_schema.columns where table_name = 'wager_transactions' and column_name = 'reference_retry_attempts'",
      ),
    ).toEqual([]);
    await migrator.down();
    const previousStatusConstraint = await connection().execute(
      "select pg_get_constraintdef(oid) as definition from pg_constraint where conname = 'wager_transactions_status_fields'",
    );
    expect(previousStatusConstraint[0]?.definition).not.toContain(
      "REFERENCE_NOT_PROCESSED",
    );
    await migrator.down();
    expect(
      await connection().execute(
        "select to_regclass('wager_transactions_processed_reversal_unique') as name",
      ),
    ).toEqual([{ name: null }]);
    await migrator.down();
    expect(
      await connection().execute("select to_regclass('wallets') as name"),
    ).toEqual([{ name: null }]);
    await migrator.up();
    expect(
      await connection().execute("select to_regclass('wallets') as name"),
    ).toEqual([{ name: "wallets" }]);
  });

  test("audits every Wallet, WagerTransaction and Ledger row across financial outcomes", async () => {
    const auditDatabaseName = `wagering_test_audit_${randomUUID().replaceAll("-", "")}`;
    let auditOrm: MikroORM | null = null;
    let auditDatabaseCreated = false;
    try {
      await admin.em
        .getConnection()
        .execute(`create database "${auditDatabaseName}"`);
      auditDatabaseCreated = true;
      const environment = parseEnvironment({
        ...process.env,
        POSTGRES_DB: auditDatabaseName,
      });
      auditOrm = await MikroORM.init(databaseConfig(environment));
      await auditOrm.getMigrator().up();

      const wallet = await new CreateWallet(
        new MikroOrmWalletCreationStore(auditOrm),
      ).execute({
        playerId: `global-audit-player-${randomUUID()}`,
        currency: "BRL",
        initialBalance: "100.00",
      });
      const useCase = new ProcessWagerTransaction(
        new MikroOrmWagerTransactionProcessingStore(auditOrm),
      );
      const betIdentity = `global-audit-bet-${randomUUID()}`;
      const refundIdentity = `global-audit-refund-${randomUUID()}`;
      await useCase.execute(
        processInput(wallet, WagerTransactionKind.BET, "20.00", betIdentity),
      );
      await useCase.execute(
        processInput(wallet, WagerTransactionKind.WIN, "30.00"),
      );
      await useCase.execute(
        processInput(wallet, WagerTransactionKind.LOSS, "2.00"),
      );
      await useCase.execute(
        processInput(
          wallet,
          WagerTransactionKind.REFUND,
          "20.00",
          refundIdentity,
          `external-${betIdentity}`,
        ),
      );
      await useCase.execute(
        processInput(
          wallet,
          WagerTransactionKind.ROLLBACK,
          "20.00",
          `global-audit-rollback-${randomUUID()}`,
          `external-${refundIdentity}`,
        ),
      );
      await useCase.execute(
        processInput(wallet, WagerTransactionKind.BET, "500.00"),
      );
      await useCase.execute(
        processInput(
          wallet,
          WagerTransactionKind.REFUND,
          "20.00",
          `global-audit-pending-${randomUUID()}`,
          `missing-${randomUUID()}`,
        ),
      );

      const result = await assertGlobalFinancialConsistency(auditOrm);
      expect(result).toMatchObject({
        walletsChecked: 1,
        transactionsChecked: 8,
        ledgerEntriesChecked: 5,
      });
      expect(
        Object.values(result.checks).every((check) => check === "PASS"),
      ).toBe(true);
      process.stdout.write(
        `[GLOBAL_FINANCIAL_AUDIT] ${JSON.stringify(result)}\n`,
      );
    } finally {
      if (auditOrm !== null) await auditOrm.close(true);
      if (auditDatabaseCreated) {
        await admin.em
          .getConnection()
          .execute(
            "select pg_terminate_backend(pid) from pg_stat_activity where datname = ? and pid <> pg_backend_pid()",
            [auditDatabaseName],
          );
        await admin.em
          .getConnection()
          .execute(`drop database "${auditDatabaseName}"`);
        auditDatabaseCreated = false;
        await removeOwnedMigrationSnapshot(auditDatabaseName);
      }
    }
  });

  test("creates a zero-balance wallet without opening, ledger or outbox rows", async () => {
    const playerId = `zero-player-${randomUUID()}`;
    const wallet = await new CreateWallet(
      new MikroOrmWalletCreationStore(orm),
    ).execute({ playerId, currency: "BRL", initialBalance: "0.00" });

    expect(wallet.version).toBe(1);
    expect(wallet.balance.toJSON().amount).toBe("0.00");
    expect(await financialRowCounts(playerId)).toEqual({
      wallets: 1,
      transactions: 0,
      ledger: 0,
      outbox: 0,
    });
    expect(await reconstructedBalance(playerId)).toEqual({
      amount: "0.00",
      currency: "BRL",
    });
  });

  test("creates a positive opening transaction, ledger and two outbox events atomically", async () => {
    const playerId = `funded-player-${randomUUID()}`;
    const wallet = await new CreateWallet(
      new MikroOrmWalletCreationStore(orm),
    ).execute({ playerId, currency: "BRL", initialBalance: "25.90" });
    const counts = await financialRowCounts(playerId);
    expect(counts).toEqual({
      wallets: 1,
      transactions: 1,
      ledger: 1,
      outbox: 2,
    });

    const rows = await connection().execute(
      `select wt.status, wt.amount as transaction_amount,
              wt.resulting_balance,
              le.direction, le.amount as ledger_amount,
              le.balance_before, le.balance_after,
              w.balance as wallet_balance
       from wallets w
       join wager_transactions wt on wt.wallet_id = w.id
       join wallet_ledger_entries le on le.transaction_id = wt.id
       where w.player_id = ?`,
      [playerId],
    );
    expect(rows).toEqual([
      {
        status: "PROCESSED",
        transaction_amount: "25.90",
        resulting_balance: "25.90",
        direction: "CREDIT",
        ledger_amount: "25.90",
        balance_before: "0.00",
        balance_after: "25.90",
        wallet_balance: "25.90",
      },
    ]);
    expect(typeof rows[0]?.transaction_amount).toBe("string");
    expect(typeof rows[0]?.resulting_balance).toBe("string");
    expect(typeof rows[0]?.ledger_amount).toBe("string");
    expect(typeof rows[0]?.wallet_balance).toBe("string");
    const outboxRows = await connection().execute(
      "select payload from outbox_messages where payload->>'playerId' = ?",
      [playerId],
    );
    expect(outboxRows).toHaveLength(2);
    for (const row of outboxRows as Array<{
      payload: { money: { amount: unknown } };
    }>) {
      expect(typeof row.payload.money.amount).toBe("string");
    }
    expect(await reconstructedBalance(playerId)).toEqual({
      amount: "25.90",
      currency: "BRL",
    });
    expect(wallet.balance.toJSON().amount).toBe("25.90");
    const em = orm.em.fork({ clear: true });
    const openingRecord = await em.findOneOrFail(WagerTransactionRecord, {
      walletId: wallet.id,
    });
    expect(typeof openingRecord.resultingBalance).toBe("string");
    expect(
      wagerTransactionFromRecord(openingRecord).resultingBalance?.toJSON(),
    ).toEqual({ amount: "25.90", currency: "BRL" });
    expect(
      wagerTransactionToRecord(wagerTransactionFromRecord(openingRecord))
        .resultingBalance,
    ).toBe("25.90");
  });

  test("rolls back every wallet creation write when an outbox insert fails", async () => {
    const playerId = `rollback-player-${randomUUID()}`;
    await connection().execute(`
      create function reject_wallet_creation_outbox() returns trigger language plpgsql as $$
      begin
        if new.event_type = 'wallet.balance.changed.v1' then
          raise exception 'Forced wallet creation failure';
        end if;
        return new;
      end;
      $$;
      create trigger reject_wallet_creation_outbox_trigger
      before insert on outbox_messages for each row
      execute function reject_wallet_creation_outbox();
    `);
    try {
      await expect(
        new CreateWallet(new MikroOrmWalletCreationStore(orm)).execute({
          playerId,
          currency: "BRL",
          initialBalance: "5.00",
        }),
      ).rejects.toThrow("Forced wallet creation failure");
    } finally {
      await connection().execute(
        "drop trigger reject_wallet_creation_outbox_trigger on outbox_messages",
      );
      await connection().execute(
        "drop function reject_wallet_creation_outbox()",
      );
    }
    expect(await financialRowCounts(playerId)).toEqual({
      wallets: 0,
      transactions: 0,
      ledger: 0,
      outbox: 0,
    });
  });

  test("creates only one wallet and financial opening under concurrent duplicates", async () => {
    const playerId = `concurrent-player-${randomUUID()}`;
    const createWallet = new CreateWallet(new MikroOrmWalletCreationStore(orm));
    const results = await Promise.allSettled([
      createWallet.execute({
        playerId,
        currency: "BRL",
        initialBalance: "9.99",
      }),
      createWallet.execute({
        playerId,
        currency: "BRL",
        initialBalance: "9.99",
      }),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    const rejection = results.find((result) => result.status === "rejected");
    expect(rejection?.status).toBe("rejected");
    if (rejection?.status === "rejected") {
      expect(rejection.reason).toBeInstanceOf(WalletAlreadyExistsError);
    }
    expect(await financialRowCounts(playerId)).toEqual({
      wallets: 1,
      transactions: 1,
      ledger: 1,
      outbox: 2,
    });
    expect(await reconstructedBalance(playerId)).toEqual({
      amount: "9.99",
      currency: "BRL",
    });
  });

  test("creates wallets through HTTP and validates the decimal-string contract", async () => {
    const module = await Test.createTestingModule({
      controllers: [WalletsController],
      providers: [
        { provide: MikroORM, useValue: orm },
        MikroOrmWalletCreationStore,
        MikroOrmWalletReadStore,
        {
          provide: CreateWallet,
          inject: [MikroOrmWalletCreationStore],
          useFactory: (store: MikroOrmWalletCreationStore) =>
            new CreateWallet(store),
        },
        {
          provide: ReadWallet,
          inject: [MikroOrmWalletReadStore],
          useFactory: (store: MikroOrmWalletReadStore) => new ReadWallet(store),
        },
        {
          provide: ReadWalletLedger,
          inject: [MikroOrmWalletReadStore],
          useFactory: (store: MikroOrmWalletReadStore) =>
            new ReadWalletLedger(store),
        },
      ],
    }).compile();
    const app: INestApplication = module.createNestApplication();
    await app.listen(0, "127.0.0.1");
    const baseUrl = await app.getUrl();
    try {
      const zeroResponse = await fetch(`${baseUrl}/wallets`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          playerId: `http-zero-${randomUUID()}`,
          currency: "BRL",
          initialBalance: "0.00",
        }),
      });
      expect(zeroResponse.status).toBe(201);
      const zeroBody = (await zeroResponse.json()) as { balance: unknown };
      expect(zeroBody.balance).toBe("0.00");

      const positivePlayer = `http-positive-${randomUUID()}`;
      const positiveResponse = await fetch(`${baseUrl}/wallets`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          playerId: positivePlayer,
          currency: "BRL",
          initialBalance: "12.34",
        }),
      });
      expect(positiveResponse.status).toBe(201);
      const positiveBody = (await positiveResponse.json()) as {
        balance: unknown;
      };
      expect(positiveBody.balance).toBe("12.34");
      expect(typeof positiveBody.balance).toBe("string");

      const positiveWallet = await connection().execute(
        "select id from wallets where player_id = ? and currency = 'BRL'",
        [positivePlayer],
      );
      const positiveWalletId = (positiveWallet[0] as { id: string }).id;
      const walletRead = await fetch(`${baseUrl}/wallets/${positiveWalletId}`);
      expect(walletRead.status).toBe(200);
      expect(await walletRead.json()).toMatchObject({
        id: positiveWalletId,
        playerId: positivePlayer,
        currency: "BRL",
        balance: { amount: "12.34", currency: "BRL" },
        version: 1,
      });
      const openingLedgerRead = await fetch(
        `${baseUrl}/wallets/${positiveWalletId}/ledger`,
      );
      expect(openingLedgerRead.status).toBe(200);
      const openingLedgerBody = (await openingLedgerRead.json()) as {
        items: Array<{ direction: string; money: { amount: string } }>;
        nextCursor: string | null;
      };
      expect(openingLedgerBody.items).toHaveLength(1);
      expect(openingLedgerBody.items[0]).toMatchObject({
        direction: "CREDIT",
        money: { amount: "12.34", currency: "BRL" },
      });
      expect(openingLedgerBody.nextCursor).toBeNull();
      expect(
        (await fetch(`${baseUrl}/wallets/missing-${randomUUID()}`)).status,
      ).toBe(404);
      const emptyPlayer = `http-empty-${randomUUID()}`;
      await new CreateWallet(new MikroOrmWalletCreationStore(orm)).execute({
        playerId: emptyPlayer,
        currency: "BRL",
        initialBalance: "0.00",
      });
      const emptyWallet = await connection().execute(
        "select id from wallets where player_id = ? and currency = 'BRL'",
        [emptyPlayer],
      );
      const emptyLedger = await fetch(
        `${baseUrl}/wallets/${(emptyWallet[0] as { id: string }).id}/ledger`,
      );
      expect(emptyLedger.status).toBe(200);
      expect(await emptyLedger.json()).toEqual({ items: [], nextCursor: null });

      const numberResponse = await fetch(`${baseUrl}/wallets`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          playerId: `http-number-${randomUUID()}`,
          currency: "BRL",
          initialBalance: 12.34,
        }),
      });
      expect(numberResponse.status).toBe(400);

      const malformedResponse = await fetch(`${baseUrl}/wallets`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          playerId: `http-malformed-${randomUUID()}`,
          currency: "BRL",
          initialBalance: "12.345",
        }),
      });
      expect(malformedResponse.status).toBe(400);

      const duplicatePlayer = `http-duplicate-${randomUUID()}`;
      const duplicatePayload = JSON.stringify({
        playerId: duplicatePlayer,
        currency: "BRL",
        initialBalance: "0.00",
      });
      expect(
        (
          await fetch(`${baseUrl}/wallets`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: duplicatePayload,
          })
        ).status,
      ).toBe(201);
      expect(
        (
          await fetch(`${baseUrl}/wallets`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: duplicatePayload,
          })
        ).status,
      ).toBe(409);
    } finally {
      await app.close();
    }
  });

  test("processes wagering transactions through HTTP against PostgreSQL", async () => {
    const module = await Test.createTestingModule({
      controllers: [WageringTransactionsController],
      providers: [
        { provide: MikroORM, useValue: orm },
        MikroOrmWagerTransactionProcessingStore,
        {
          provide: ProcessWagerTransaction,
          inject: [MikroOrmWagerTransactionProcessingStore],
          useFactory: (store: MikroOrmWagerTransactionProcessingStore) =>
            new ProcessWagerTransaction(store),
        },
      ],
    }).compile();
    const app: INestApplication = module.createNestApplication();
    await app.listen(0, "127.0.0.1");
    const baseUrl = await app.getUrl();
    const post = (key: string | undefined, body: Record<string, unknown>) =>
      fetch(`${baseUrl}/wagering/transactions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(key === undefined ? {} : { "idempotency-key": key }),
        },
        body: JSON.stringify(body),
      });
    const request = (
      playerId: string,
      walletId: string,
      externalTransactionId: string,
      kind: string,
      amount: string,
      referenceExternalTransactionId?: string,
    ): Record<string, unknown> => ({
      providerId: "http-provider",
      externalTransactionId,
      playerId,
      walletId,
      roundId: "http-round",
      gameId: "http-game",
      kind,
      money: { amount, currency: "BRL" },
      ...(referenceExternalTransactionId === undefined
        ? {}
        : { referenceExternalTransactionId }),
    });
    try {
      const funded = await createFundedWallet("100.00");
      const betBody = request(
        funded.playerId,
        funded.wallet.id,
        `http-bet-${randomUUID()}`,
        "BET",
        "20.00",
      );
      const first = await post("http-key-bet", betBody);
      expect(first.status).toBe(201);
      const firstBody = (await first.json()) as {
        transactionId: string;
        status: string;
        resultingBalance: { amount: string; currency: string };
      };
      expect(firstBody.status).toBe("PROCESSED");
      expect(firstBody.resultingBalance).toEqual({
        amount: "80.00",
        currency: "BRL",
      });

      const replay = await post("http-key-bet", betBody);
      expect(replay.status).toBe(200);
      const replayBody = (await replay.json()) as {
        transactionId: string;
        idempotentReplay: boolean;
        resultingBalance: { amount: string };
      };
      expect(replayBody.transactionId).toBe(firstBody.transactionId);
      expect(replayBody.idempotentReplay).toBe(true);
      expect(replayBody.resultingBalance.amount).toBe("80.00");

      const changedPayload = { ...betBody, gameId: "different-game" };
      expect((await post("http-key-bet", changedPayload)).status).toBe(409);
      expect(
        (
          await post("different-key", {
            ...betBody,
            externalTransactionId: betBody.externalTransactionId,
            money: { amount: "21.00", currency: "BRL" },
          })
        ).status,
      ).toBe(409);

      const nextWin = request(
        funded.playerId,
        funded.wallet.id,
        `http-win-${randomUUID()}`,
        "WIN",
        "40.00",
      );
      expect((await post("http-key-win", nextWin)).status).toBe(201);
      const historicalReplay = await post("http-key-bet", betBody);
      const historicalBody = (await historicalReplay.json()) as {
        resultingBalance: { amount: string };
      };
      expect(historicalReplay.status).toBe(200);
      expect(historicalBody.resultingBalance.amount).toBe("80.00");

      const emptyWallet = await createFundedWallet("0.00");
      const rejected = await post(
        "http-key-insufficient",
        request(
          emptyWallet.playerId,
          emptyWallet.wallet.id,
          `http-insufficient-${randomUUID()}`,
          "BET",
          "1.00",
        ),
      );
      expect(rejected.status).toBe(422);
      expect(await rejected.json()).toMatchObject({
        status: "REJECTED",
        failureCode: "INSUFFICIENT_FUNDS",
      });

      const pending = await post(
        "http-key-pending",
        request(
          funded.playerId,
          funded.wallet.id,
          `http-pending-${randomUUID()}`,
          "REFUND",
          "20.00",
          "not-yet-present",
        ),
      );
      expect(pending.status).toBe(202);
      expect(await pending.json()).toMatchObject({
        status: "PENDING_REFERENCE",
      });

      expect(
        (
          await post("invalid-money", {
            ...betBody,
            externalTransactionId: `invalid-${randomUUID()}`,
            money: { amount: 20, currency: "BRL" },
          })
        ).status,
      ).toBe(400);
      expect((await post(undefined, betBody)).status).toBe(400);
      expect((await post(" ", betBody)).status).toBe(400);
      expect(
        (
          await post("opening", {
            ...betBody,
            externalTransactionId: `opening-${randomUUID()}`,
            kind: "OPENING",
          })
        ).status,
      ).toBe(400);
      expect(
        (
          await post("missing-ref", {
            ...betBody,
            externalTransactionId: `refund-no-ref-${randomUUID()}`,
            kind: "REFUND",
          })
        ).status,
      ).toBe(400);
      expect(
        (
          await post("bet-ref", {
            ...betBody,
            externalTransactionId: `bet-ref-${randomUUID()}`,
            referenceExternalTransactionId: "ref",
          })
        ).status,
      ).toBe(400);

      expect(
        (
          await post(
            "wallet-not-found",
            request(
              funded.playerId,
              randomUUID(),
              `not-found-${randomUUID()}`,
              "BET",
              "1.00",
            ),
          )
        ).status,
      ).toBe(404);
      expect(
        (
          await post(
            "player-mismatch",
            request(
              "another-player",
              funded.wallet.id,
              `player-mismatch-${randomUUID()}`,
              "BET",
              "1.00",
            ),
          )
        ).status,
      ).toBe(422);
      expect(
        (
          await post("currency-mismatch", {
            ...request(
              funded.playerId,
              funded.wallet.id,
              `currency-mismatch-${randomUUID()}`,
              "BET",
              "1.00",
            ),
            money: { amount: "1.00", currency: "USD" },
          })
        ).status,
      ).toBe(422);

      const concurrentWallet = await createFundedWallet("100.00");
      const concurrentResponses = await Promise.all([
        post(
          "http-concurrent-a",
          request(
            concurrentWallet.playerId,
            concurrentWallet.wallet.id,
            `concurrent-a-${randomUUID()}`,
            "BET",
            "80.00",
          ),
        ),
        post(
          "http-concurrent-b",
          request(
            concurrentWallet.playerId,
            concurrentWallet.wallet.id,
            `concurrent-b-${randomUUID()}`,
            "BET",
            "80.00",
          ),
        ),
      ]);
      expect(concurrentResponses.map((result) => result.status).sort()).toEqual(
        [201, 422],
      );
      const concurrentWalletAfter = await connection().execute(
        "select balance, version from wallets where id = ?",
        [concurrentWallet.wallet.id],
      );
      expect(concurrentWalletAfter).toEqual([
        { balance: "20.00", version: "2" },
      ]);
      expect(
        await reconstructedWalletBalance(concurrentWallet.wallet.id),
      ).toEqual({
        amount: "20.00",
        currency: "BRL",
      });
    } finally {
      await app.close();
    }
  });

  test("serves wallet, transaction and stable ledger read APIs over HTTP", async () => {
    const module = await Test.createTestingModule({
      controllers: [
        WalletsController,
        WagerTransactionReadsController,
        ProviderWagerTransactionReadsController,
      ],
      providers: [
        { provide: MikroORM, useValue: orm },
        MikroOrmWalletCreationStore,
        MikroOrmWalletReadStore,
        MikroOrmWagerTransactionReadStore,
        {
          provide: CreateWallet,
          inject: [MikroOrmWalletCreationStore],
          useFactory: (store: MikroOrmWalletCreationStore) =>
            new CreateWallet(store),
        },
        {
          provide: ReadWallet,
          inject: [MikroOrmWalletReadStore],
          useFactory: (store: MikroOrmWalletReadStore) => new ReadWallet(store),
        },
        {
          provide: ReadWalletLedger,
          inject: [MikroOrmWalletReadStore],
          useFactory: (store: MikroOrmWalletReadStore) =>
            new ReadWalletLedger(store),
        },
        {
          provide: ReadWagerTransaction,
          inject: [MikroOrmWagerTransactionReadStore],
          useFactory: (store: MikroOrmWagerTransactionReadStore) =>
            new ReadWagerTransaction(store),
        },
      ],
    }).compile();
    const app: INestApplication = module.createNestApplication();
    await app.listen(0, "127.0.0.1");
    const baseUrl = await app.getUrl();
    try {
      const { playerId, wallet } = await createFundedWallet("100.00");
      const betIdentity = `read-bet-${randomUUID()}`;
      const bet = await processor().execute(
        processInput(wallet, WagerTransactionKind.BET, "20.00", betIdentity),
      );
      const win = await processor().execute(
        processInput(
          wallet,
          WagerTransactionKind.WIN,
          "5.00",
          `read-win-${randomUUID()}`,
        ),
      );
      const beforeReads = await countsForPlayer(playerId);
      const walletBeforeReads = await readWallet(wallet.id);
      const inboxBeforeReads = await connection().execute(
        "select count(*)::integer as count from inbox_messages",
      );

      const walletResponse = await fetch(`${baseUrl}/wallets/${wallet.id}`);
      expect(walletResponse.status).toBe(200);
      expect(await walletResponse.json()).toMatchObject({
        id: wallet.id,
        playerId,
        currency: "BRL",
        balance: { amount: "85.00", currency: "BRL" },
        version: 3,
      });

      const transactionResponse = await fetch(
        `${baseUrl}/wagering/transactions/${bet.transactionId}`,
      );
      expect(transactionResponse.status).toBe(200);
      const transactionBody = (await transactionResponse.json()) as {
        id: string;
        kind: string;
        status: string;
        money: { amount: string; currency: string };
        resultingBalance: { amount: string; currency: string };
      };
      expect(transactionBody).toMatchObject({
        id: bet.transactionId,
        kind: "BET",
        status: "PROCESSED",
        money: { amount: "20.00", currency: "BRL" },
        resultingBalance: { amount: "80.00", currency: "BRL" },
      });
      expect(
        (
          await fetch(
            `${baseUrl}/providers/integration-provider/wagering/transactions/external-${betIdentity}`,
          )
        ).status,
      ).toBe(200);
      expect(
        (
          await fetch(
            `${baseUrl}/providers/wrong-provider/wagering/transactions/external-${betIdentity}`,
          )
        ).status,
      ).toBe(404);
      expect(
        (
          await fetch(
            `${baseUrl}/providers/integration-provider/wagering/transactions/missing-${randomUUID()}`,
          )
        ).status,
      ).toBe(404);
      expect(
        (
          await fetch(
            `${baseUrl}/wagering/transactions/missing-${randomUUID()}`,
          )
        ).status,
      ).toBe(404);

      const defaultPageResponse = await fetch(
        `${baseUrl}/wallets/${wallet.id}/ledger`,
      );
      expect(defaultPageResponse.status).toBe(200);
      const defaultPage = (await defaultPageResponse.json()) as {
        items: Array<{ id: string; transactionId: string; direction: string }>;
        nextCursor: string | null;
      };
      expect(defaultPage.items).toHaveLength(3);
      expect(defaultPage.nextCursor).toBeNull();
      const expectedLedgerRows = await connection().execute(
        "select id from wallet_ledger_entries where wallet_id = ? order by created_at desc, id desc",
        [wallet.id],
      );
      expect(defaultPage.items.map((entry) => entry.id)).toEqual(
        (expectedLedgerRows as Array<{ id: string }>).map((row) => row.id),
      );
      expect(
        defaultPage.items.some(
          (entry) => entry.transactionId === bet.transactionId,
        ),
      ).toBe(true);
      expect(
        defaultPage.items.some(
          (entry) => entry.transactionId === win.transactionId,
        ),
      ).toBe(true);
      expect(
        defaultPage.items.some((entry) => entry.direction === "CREDIT"),
      ).toBe(true);

      const firstPageResponse = await fetch(
        `${baseUrl}/wallets/${wallet.id}/ledger?limit=2`,
      );
      const firstPage = (await firstPageResponse.json()) as {
        items: Array<{ id: string }>;
        nextCursor: string | null;
      };
      expect(firstPage.items).toHaveLength(2);
      expect(firstPage.nextCursor).not.toBeNull();
      const finalPageResponse = await fetch(
        `${baseUrl}/wallets/${wallet.id}/ledger?limit=2&cursor=${encodeURIComponent(firstPage.nextCursor ?? "")}`,
      );
      const finalPage = (await finalPageResponse.json()) as {
        items: Array<{ id: string }>;
        nextCursor: string | null;
      };
      expect(finalPage.items).toHaveLength(1);
      expect(finalPage.nextCursor).toBeNull();
      expect(
        [...firstPage.items, ...finalPage.items].map((item) => item.id),
      ).toHaveLength(3);
      expect(
        new Set([...firstPage.items, ...finalPage.items].map((item) => item.id))
          .size,
      ).toBe(3);

      const invalidQueries = [
        "limit=0",
        "limit=-1",
        "limit=101",
        "limit=1.5",
        "cursor=%%%",
      ];
      for (const query of invalidQueries) {
        expect(
          (await fetch(`${baseUrl}/wallets/${wallet.id}/ledger?${query}`))
            .status,
        ).toBe(400);
      }
      const secondWallet = await createFundedWallet("0.00");
      expect(
        (
          await fetch(
            `${baseUrl}/wallets/${secondWallet.wallet.id}/ledger?limit=1&cursor=${encodeURIComponent(firstPage.nextCursor ?? "")}`,
          )
        ).status,
      ).toBe(400);
      expect(
        (await fetch(`${baseUrl}/wallets/missing-${randomUUID()}/ledger`))
          .status,
      ).toBe(404);

      expect(await readWallet(wallet.id)).toEqual(walletBeforeReads);
      expect(await countsForPlayer(playerId)).toEqual(beforeReads);
      expect(
        await connection().execute(
          "select count(*)::integer as count from inbox_messages",
        ),
      ).toEqual(inboxBeforeReads);

      const tieWallet = await createFundedWallet("0.00");
      const tieTimestamp = new Date("2026-01-01T00:00:00.000Z");
      const tiedEntries = [
        { suffix: "a", before: "0.00", after: "1.00" },
        { suffix: "b", before: "1.00", after: "2.00" },
        { suffix: "c", before: "2.00", after: "3.00" },
        { suffix: "d", before: "3.00", after: "4.00" },
      ];
      for (const entry of tiedEntries) {
        const transactionId = `tie-transaction-${entry.suffix}-${randomUUID()}`;
        const externalId = `tie-external-${entry.suffix}-${randomUUID()}`;
        await connection().execute(
          `insert into wager_transactions (
            id, provider_id, external_transaction_id, idempotency_key, payload_hash,
            wallet_id, player_id, round_id, game_id, kind, status, amount,
            resulting_balance, currency, processed_at, created_at, updated_at
          ) values (?, 'tie-provider', ?, ?, 'tie-hash', ?, ?, 'tie-round', 'tie-game',
            'WIN', 'PROCESSED', '1.00', ?, 'BRL', ?, ?, ?)`,
          [
            transactionId,
            externalId,
            `tie-key-${randomUUID()}`,
            tieWallet.wallet.id,
            tieWallet.playerId,
            entry.after,
            tieTimestamp,
            tieTimestamp,
            tieTimestamp,
          ],
        );
        await connection().execute(
          `insert into wallet_ledger_entries
           (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, created_at)
           values (?, ?, ?, 'CREDIT', '1.00', 'BRL', ?, ?, ?)`,
          [
            `tie-ledger-${entry.suffix}`,
            tieWallet.wallet.id,
            transactionId,
            entry.before,
            entry.after,
            tieTimestamp,
          ],
        );
      }
      await connection().execute(
        "update wallets set balance = '4.00', version = 5 where id = ?",
        [tieWallet.wallet.id],
      );
      const tiedFirstResponse = await fetch(
        `${baseUrl}/wallets/${tieWallet.wallet.id}/ledger?limit=2`,
      );
      const tiedFirst = (await tiedFirstResponse.json()) as {
        items: Array<{ id: string }>;
        nextCursor: string | null;
      };
      expect(tiedFirst.items.map((item) => item.id)).toEqual([
        "tie-ledger-d",
        "tie-ledger-c",
      ]);
      const insertedTransactionId = `tie-transaction-e-${randomUUID()}`;
      await connection().execute(
        `insert into wager_transactions (
          id, provider_id, external_transaction_id, idempotency_key, payload_hash,
          wallet_id, player_id, round_id, game_id, kind, status, amount,
          resulting_balance, currency, processed_at, created_at, updated_at
        ) values (?, 'tie-provider', ?, ?, 'tie-hash', ?, ?, 'tie-round', 'tie-game',
          'WIN', 'PROCESSED', '1.00', '5.00', 'BRL', ?, ?, ?)`,
        [
          insertedTransactionId,
          `tie-external-e-${randomUUID()}`,
          `tie-key-e-${randomUUID()}`,
          tieWallet.wallet.id,
          tieWallet.playerId,
          new Date(tieTimestamp.getTime() + 1),
          new Date(tieTimestamp.getTime() + 1),
          new Date(tieTimestamp.getTime() + 1),
        ],
      );
      await connection().execute(
        `insert into wallet_ledger_entries
         (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, created_at)
         values ('tie-ledger-e', ?, ?, 'CREDIT', '1.00', 'BRL', '4.00', '5.00', ?)`,
        [
          tieWallet.wallet.id,
          insertedTransactionId,
          new Date(tieTimestamp.getTime() + 1),
        ],
      );
      await connection().execute(
        "update wallets set balance = '5.00', version = 6 where id = ?",
        [tieWallet.wallet.id],
      );
      const tiedSecondResponse = await fetch(
        `${baseUrl}/wallets/${tieWallet.wallet.id}/ledger?limit=2&cursor=${encodeURIComponent(tiedFirst.nextCursor ?? "")}`,
      );
      const tiedSecond = (await tiedSecondResponse.json()) as {
        items: Array<{ id: string }>;
        nextCursor: string | null;
      };
      expect(tiedSecond.items.map((item) => item.id)).toEqual([
        "tie-ledger-b",
        "tie-ledger-a",
      ]);
      expect(tiedSecond.nextCursor).toBeNull();
      expect(
        [...tiedFirst.items, ...tiedSecond.items].map((item) => item.id),
      ).toEqual([
        "tie-ledger-d",
        "tie-ledger-c",
        "tie-ledger-b",
        "tie-ledger-a",
      ]);
    } finally {
      await app.close();
    }
  });

  test.skipIf(!enabled)(
    "reconciles wallet balance and full ledger history over a repeatable-read snapshot",
    async () => {
      const warnings: Array<Record<string, unknown>> = [];
      const metricsRegistry = new Registry();
      const wageringMetrics = new WageringMetrics(metricsRegistry);
      const module = await Test.createTestingModule({
        controllers: [WalletReconciliationController],
        providers: [
          { provide: MikroORM, useValue: orm },
          { provide: Registry, useValue: metricsRegistry },
          { provide: WageringMetrics, useValue: wageringMetrics },
          MikroOrmWalletReconciliationStore,
          {
            provide: ReconcileWallet,
            inject: [MikroOrmWalletReconciliationStore],
            useFactory: (store: MikroOrmWalletReconciliationStore) =>
              new ReconcileWallet(store),
          },
          {
            provide: PinoLogger,
            useValue: {
              warn: (context: Record<string, unknown>) =>
                warnings.push(context),
            },
          },
        ],
      }).compile();
      const app = module.createNestApplication();
      await app.listen(0, "127.0.0.1");
      const baseUrl = await app.getUrl();
      try {
        const empty = await createFundedWallet("0.00");
        const emptyResponse = await fetch(
          `${baseUrl}/wallets/${empty.wallet.id}/reconciliation`,
          { method: "POST" },
        );
        expect(emptyResponse.status).toBe(201);
        expect(await emptyResponse.json()).toEqual({
          storedBalance: { amount: "0.00", currency: "BRL" },
          calculatedBalance: { amount: "0.00", currency: "BRL" },
          difference: { amount: "0.00", currency: "BRL" },
          consistent: true,
          checkedEntries: 0,
        });

        const { playerId, wallet } = await createFundedWallet("100.00");
        const openingResponse = await fetch(
          `${baseUrl}/wallets/${wallet.id}/reconciliation`,
          { method: "POST" },
        );
        expect(openingResponse.status).toBe(201);
        expect(await openingResponse.json()).toEqual({
          storedBalance: { amount: "100.00", currency: "BRL" },
          calculatedBalance: { amount: "100.00", currency: "BRL" },
          difference: { amount: "0.00", currency: "BRL" },
          consistent: true,
          checkedEntries: 1,
        });
        const betIdentity = `reconcile-bet-${randomUUID()}`;
        await processor().execute(
          processInput(wallet, WagerTransactionKind.BET, "20.00", betIdentity),
        );
        await processor().execute(
          processInput(wallet, WagerTransactionKind.WIN, "30.00"),
        );
        const refundIdentity = `reconcile-refund-${randomUUID()}`;
        await processor().execute(
          processInput(
            wallet,
            WagerTransactionKind.REFUND,
            "20.00",
            refundIdentity,
            `external-${betIdentity}`,
          ),
        );
        await processor().execute(
          processInput(
            wallet,
            WagerTransactionKind.ROLLBACK,
            "20.00",
            `reconcile-rollback-${randomUUID()}`,
            `external-${refundIdentity}`,
          ),
        );
        await processor().execute(
          processInput(wallet, WagerTransactionKind.LOSS, "7.00"),
        );
        const rejected = await processor().execute(
          processInput(wallet, WagerTransactionKind.BET, "999.00"),
        );
        expect(rejected.status).toBe(WagerTransactionStatus.REJECTED);
        const pending = await processor().execute(
          processInput(
            wallet,
            WagerTransactionKind.REFUND,
            "1.00",
            `reconcile-pending-${randomUUID()}`,
            `external-missing-${randomUUID()}`,
          ),
        );
        expect(pending.status).toBe(WagerTransactionStatus.PENDING_REFERENCE);

        const before = await connection().execute(
          `select w.balance, w.version,
             (select count(*)::integer from wager_transactions where wallet_id = w.id) as transactions,
             (select count(*)::integer from wallet_ledger_entries where wallet_id = w.id) as ledger,
             (select count(*)::integer from outbox_messages where payload->>'playerId' = ?) as outbox,
             (select count(*)::integer from inbox_messages) as inbox
           from wallets w where w.id = ?`,
          [playerId, wallet.id],
        );
        const response = await fetch(
          `${baseUrl}/wallets/${wallet.id}/reconciliation`,
          { method: "POST" },
        );
        expect(response.status).toBe(201);
        expect(await response.json()).toEqual({
          storedBalance: { amount: "110.00", currency: "BRL" },
          calculatedBalance: { amount: "110.00", currency: "BRL" },
          difference: { amount: "0.00", currency: "BRL" },
          consistent: true,
          checkedEntries: 5,
        });
        const after = await connection().execute(
          `select w.balance, w.version,
             (select count(*)::integer from wager_transactions where wallet_id = w.id) as transactions,
             (select count(*)::integer from wallet_ledger_entries where wallet_id = w.id) as ledger,
             (select count(*)::integer from outbox_messages where payload->>'playerId' = ?) as outbox,
             (select count(*)::integer from inbox_messages) as inbox
           from wallets w where w.id = ?`,
          [playerId, wallet.id],
        );
        expect(after).toEqual(before);
        expect(warnings).toHaveLength(0);

        const concurrentWallet = await createFundedWallet("100.00");
        let releaseConcurrentStart = (): void => {};
        const concurrentStart = new Promise<void>((resolve) => {
          releaseConcurrentStart = resolve;
        });
        const concurrentReconciliation = (async () => {
          await concurrentStart;
          return fetch(
            `${baseUrl}/wallets/${concurrentWallet.wallet.id}/reconciliation`,
            { method: "POST" },
          );
        })();
        const concurrentBet = (async () => {
          await concurrentStart;
          return processor().execute(
            processInput(
              concurrentWallet.wallet,
              WagerTransactionKind.BET,
              "20.00",
            ),
          );
        })();
        releaseConcurrentStart();
        const [concurrentReconciliationResponse, concurrentBetResult] =
          await Promise.all([concurrentReconciliation, concurrentBet]);
        expect(concurrentBetResult.status).toBe(
          WagerTransactionStatus.PROCESSED,
        );
        expect(concurrentReconciliationResponse.status).toBe(201);
        const concurrentReconciliationBody =
          (await concurrentReconciliationResponse.json()) as {
            storedBalance: { amount: string };
            calculatedBalance: { amount: string };
            difference: { amount: string };
            consistent: boolean;
            checkedEntries: number;
          };
        expect(concurrentReconciliationBody.consistent).toBe(true);
        expect(concurrentReconciliationBody.difference.amount).toBe("0.00");
        expect(concurrentReconciliationBody.storedBalance.amount).toBe(
          concurrentReconciliationBody.calculatedBalance.amount,
        );
        expect(
          ["100.00", "80.00"].includes(
            concurrentReconciliationBody.storedBalance.amount,
          ),
        ).toBe(true);
        expect([1, 2]).toContain(concurrentReconciliationBody.checkedEntries);

        expect(
          (
            await fetch(`${baseUrl}/wallets/${randomUUID()}/reconciliation`, {
              method: "POST",
            })
          ).status,
        ).toBe(404);
        expect(
          (
            await fetch(`${baseUrl}/wallets/%20/reconciliation`, {
              method: "POST",
            })
          ).status,
        ).toBe(400);

        await connection().execute(
          "update wallets set balance = '115.00' where id = ?",
          [wallet.id],
        );
        const divergenceResponse = await fetch(
          `${baseUrl}/wallets/${wallet.id}/reconciliation`,
          { method: "POST" },
        );
        expect(await divergenceResponse.json()).toEqual({
          storedBalance: { amount: "115.00", currency: "BRL" },
          calculatedBalance: { amount: "110.00", currency: "BRL" },
          difference: { amount: "5.00", currency: "BRL" },
          consistent: false,
          checkedEntries: 5,
        });
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toEqual({
          walletId: wallet.id,
          storedBalance: { amount: "115.00", currency: "BRL" },
          calculatedBalance: { amount: "110.00", currency: "BRL" },
          difference: { amount: "5.00", currency: "BRL" },
          checkedEntries: 5,
        });
        expect(await metricsRegistry.metrics()).toContain(
          "wagering_reconciliation_mismatches_total 1",
        );
        expect(await readWallet(wallet.id)).toEqual({
          balance: "115.00",
          version: "5",
        });
      } finally {
        await app.close();
      }
    },
  );

  test.skipIf(!sqsEnabled)(
    "consumes FIFO messages with atomic Inbox, safe redelivery and DLQ routing",
    async () => {
      const baseEnvironment = parseEnvironment(process.env);
      const sqs = new SQSClient({
        region: baseEnvironment.AWS_REGION,
        endpoint: baseEnvironment.SQS_ENDPOINT,
        credentials: {
          accessKeyId: baseEnvironment.AWS_ACCESS_KEY_ID,
          secretAccessKey: baseEnvironment.AWS_SECRET_ACCESS_KEY,
        },
      });
      const suffix = randomUUID().replaceAll("-", "").slice(0, 16);
      const queueName = `wager-test-${suffix}.fifo`;
      const deadLetterQueueName = `wager-test-dlq-${suffix}.fifo`;
      let queueUrl: string | undefined;
      let deadLetterQueueUrl: string | undefined;
      const logger = new PinoLogger({ pinoHttp: { level: "silent" } });
      const consumerMetricsRegistry = new Registry();
      const consumerMetrics = new WageringMetrics(consumerMetricsRegistry);
      try {
        const deadLetterQueue = await sqs.send(
          new CreateQueueCommand({
            QueueName: deadLetterQueueName,
            Attributes: {
              FifoQueue: "true",
              ContentBasedDeduplication: "false",
            },
          }),
        );
        deadLetterQueueUrl = deadLetterQueue.QueueUrl;
        if (deadLetterQueueUrl === undefined) {
          throw new Error("Test dead-letter queue was not created");
        }
        const deadLetterAttributes = await sqs.send(
          new GetQueueAttributesCommand({
            QueueUrl: deadLetterQueueUrl,
            AttributeNames: ["QueueArn"],
          }),
        );
        const deadLetterArn = deadLetterAttributes.Attributes?.QueueArn;
        if (deadLetterArn === undefined) {
          throw new Error("Test dead-letter queue ARN was not returned");
        }
        const queue = await sqs.send(
          new CreateQueueCommand({
            QueueName: queueName,
            Attributes: {
              FifoQueue: "true",
              ContentBasedDeduplication: "false",
              VisibilityTimeout: "1",
              RedrivePolicy: JSON.stringify({
                deadLetterTargetArn: deadLetterArn,
                maxReceiveCount: "5",
              }),
            },
          }),
        );
        queueUrl = queue.QueueUrl;
        if (queueUrl === undefined)
          throw new Error("Test queue was not created");

        const environment = {
          ...baseEnvironment,
          SQS_WAGER_TRANSACTION_QUEUE_NAME: queueName,
          SQS_WAGER_TRANSACTION_DLQ_NAME: deadLetterQueueName,
          SQS_CONSUMER_ENABLED: false,
          SQS_CONSUMER_WAIT_TIME_SECONDS: 0,
          SQS_CONSUMER_MAX_MESSAGES: 10,
          SQS_CONSUMER_VISIBILITY_TIMEOUT_SECONDS: 1,
          SQS_CONSUMER_SHUTDOWN_TIMEOUT_MS: 1000,
        };
        const consumer = new WagerTransactionSqsConsumer(
          sqs,
          processor(consumerMetrics),
          environment,
          logger,
          consumerMetrics,
        );
        const secondConsumer = new WagerTransactionSqsConsumer(
          sqs,
          processor(consumerMetrics),
          environment,
          logger,
          consumerMetrics,
        );
        const makeData = (
          playerId: string,
          walletId: string,
          externalTransactionId: string,
          idempotencyKey: string,
          kind = "BET",
          amount = "20.00",
          referenceExternalTransactionId?: string,
        ) => ({
          providerId: "sqs-provider",
          externalTransactionId,
          idempotencyKey,
          playerId,
          walletId,
          roundId: "sqs-round",
          gameId: "sqs-game",
          kind,
          money: { amount, currency: "BRL" },
          ...(referenceExternalTransactionId === undefined
            ? {}
            : { referenceExternalTransactionId }),
        });
        const makeEnvelope = (
          messageId: string,
          data: ReturnType<typeof makeData>,
        ) => ({
          messageId,
          type: WAGER_TRANSACTION_REQUESTED_TYPE,
          occurredAt: new Date().toISOString(),
          data,
        });
        const sendEnvelope = async (
          envelope: ReturnType<typeof makeEnvelope>,
          groupId: string = randomUUID(),
        ) =>
          sqs.send(
            new SendMessageCommand({
              QueueUrl: queueUrl,
              MessageBody: JSON.stringify(envelope),
              MessageGroupId: groupId,
              MessageDeduplicationId: randomUUID(),
            }),
          );
        const receive = async (maxNumber = 1) => {
          const result = await sqs.send(
            new ReceiveMessageCommand({
              QueueUrl: queueUrl,
              MaxNumberOfMessages: maxNumber,
              WaitTimeSeconds: 0,
              VisibilityTimeout: 60,
            }),
          );
          return result.Messages ?? [];
        };
        const processReceived = async (body: string) => {
          const envelope = parseWagerTransactionRequested(body);
          return processor().executeFromInbox(envelope.data, {
            consumerName: "wager-transaction-consumer.v1",
            messageId: envelope.messageId,
            payloadHash: createHash("sha256").update(body).digest("hex"),
            receivedAt: new Date(),
          });
        };
        const deleteReceived = async (receiptHandle: string) =>
          sqs.send(
            new DeleteMessageCommand({
              QueueUrl: queueUrl,
              ReceiptHandle: receiptHandle,
            }),
          );
        const commitAndRetry = async (
          envelope: ReturnType<typeof makeEnvelope>,
        ) => {
          const body = JSON.stringify(envelope);
          await sendEnvelope(envelope);
          const [message] = await receive();
          if (
            message?.Body === undefined ||
            message.ReceiptHandle === undefined
          ) {
            throw new Error("Expected a queued wager transaction message");
          }
          await processReceived(message.Body);
          await sqs.send(
            new ChangeMessageVisibilityCommand({
              QueueUrl: queueUrl,
              ReceiptHandle: message.ReceiptHandle,
              VisibilityTimeout: 0,
            }),
          );
          await secondConsumer.pollOnce();
          expect(await receive()).toHaveLength(0);
          expect(body).toContain(envelope.messageId);
        };

        const happyWallet = await createFundedWallet("100.00");
        const happyEnvelope = makeEnvelope(
          `sqs-happy-${randomUUID()}`,
          makeData(
            happyWallet.playerId,
            happyWallet.wallet.id,
            `sqs-external-${randomUUID()}`,
            `sqs-key-${randomUUID()}`,
          ),
        );
        await sendEnvelope(happyEnvelope);
        await consumer.pollOnce();
        expect(await reconstructedWalletBalance(happyWallet.wallet.id)).toEqual(
          {
            amount: "80.00",
            currency: "BRL",
          },
        );
        const happyInbox = await connection().execute(
          "select processed_at from inbox_messages where consumer_name = ? and message_id = ?",
          ["wager-transaction-consumer.v1", happyEnvelope.messageId],
        );
        const processedAt = (happyInbox[0] as { processed_at: string | null })
          .processed_at;
        expect(typeof processedAt).toBe("string");
        expect(Number.isFinite(Date.parse(processedAt ?? ""))).toBe(true);
        const happyCounts = await connection().execute(
          `select
             (select count(*)::integer from wager_transactions where idempotency_key = ?) as transactions,
             (select count(*)::integer from wallet_ledger_entries where wallet_id = ?) as ledger,
             (select count(*)::integer from outbox_messages where payload->>'walletId' = ?) as outbox`,
          [
            happyEnvelope.data.idempotencyKey,
            happyWallet.wallet.id,
            happyWallet.wallet.id,
          ],
        );
        expect(happyCounts).toEqual([
          { transactions: 1, ledger: 2, outbox: 4 },
        ]);

        await sendEnvelope(happyEnvelope);
        await consumer.pollOnce();
        expect(await reconstructedWalletBalance(happyWallet.wallet.id)).toEqual(
          {
            amount: "80.00",
            currency: "BRL",
          },
        );
        expect(
          await connection().execute(
            "select count(*)::integer as count from wager_transactions where idempotency_key = ?",
            [happyEnvelope.data.idempotencyKey],
          ),
        ).toEqual([{ count: 1 }]);

        const sameInboxEnvelope = makeEnvelope(
          `sqs-same-inbox-${randomUUID()}`,
          makeData(
            happyWallet.playerId,
            happyWallet.wallet.id,
            `sqs-same-inbox-external-${randomUUID()}`,
            `sqs-same-inbox-key-${randomUUID()}`,
          ),
        );
        const sameBody = JSON.stringify(sameInboxEnvelope);
        await Promise.all([
          sendEnvelope(sameInboxEnvelope),
          sendEnvelope(sameInboxEnvelope),
        ]);
        const duplicates = await receive(2);
        expect(duplicates).toHaveLength(2);
        const duplicateResults = await Promise.all(
          duplicates.map(async (message) => {
            if (
              message.Body === undefined ||
              message.ReceiptHandle === undefined
            ) {
              throw new Error("Duplicate SQS message was incomplete");
            }
            const result = await processReceived(message.Body);
            await deleteReceived(message.ReceiptHandle);
            return result;
          }),
        );
        expect(
          duplicateResults.filter((result) => result.inboxDuplicate),
        ).toHaveLength(1);
        expect(
          await connection().execute(
            "select count(*)::integer as count from inbox_messages where consumer_name = ? and message_id = ?",
            ["wager-transaction-consumer.v1", sameInboxEnvelope.messageId],
          ),
        ).toEqual([{ count: 1 }]);
        expect(sameBody).toContain(sameInboxEnvelope.messageId);

        const sharedIdentityWallet = await createFundedWallet("100.00");
        const sharedData = makeData(
          sharedIdentityWallet.playerId,
          sharedIdentityWallet.wallet.id,
          `sqs-shared-external-${randomUUID()}`,
          `sqs-shared-key-${randomUUID()}`,
        );
        const sharedA = makeEnvelope(
          `sqs-shared-a-${randomUUID()}`,
          sharedData,
        );
        const sharedB = makeEnvelope(
          `sqs-shared-b-${randomUUID()}`,
          sharedData,
        );
        await sendEnvelope(sharedA, `sqs-group-a-${randomUUID()}`);
        await sendEnvelope(sharedB, `sqs-group-b-${randomUUID()}`);
        const concurrentConsumers = [sharedA, sharedB].map(
          () =>
            new WagerTransactionSqsConsumer(
              sqs,
              processor(),
              { ...environment, SQS_CONSUMER_MAX_MESSAGES: 1 },
              logger,
            ),
        );
        await Promise.all(
          concurrentConsumers.map((instance) => instance.pollOnce()),
        );
        expect(
          await connection().execute(
            `select
               (select count(*)::integer from inbox_messages where consumer_name = ? and message_id in (?, ?)) as inbox,
               (select count(*)::integer from wager_transactions where external_transaction_id = ?) as transactions,
               (select count(*)::integer from wallet_ledger_entries where wallet_id = ?) as ledger,
               (select count(*)::integer from outbox_messages where payload->>'walletId' = ?) as outbox,
               (select balance from wallets where id = ?) as balance`,
            [
              "wager-transaction-consumer.v1",
              sharedA.messageId,
              sharedB.messageId,
              sharedData.externalTransactionId,
              sharedIdentityWallet.wallet.id,
              sharedIdentityWallet.wallet.id,
              sharedIdentityWallet.wallet.id,
            ],
          ),
        ).toEqual([
          { inbox: 2, transactions: 1, ledger: 2, outbox: 4, balance: "80.00" },
        ]);
        expect(
          await connection().execute(
            "select count(*)::integer as count from inbox_messages where consumer_name = ? and message_id in (?, ?) and processed_at is not null",
            [
              "wager-transaction-consumer.v1",
              sharedA.messageId,
              sharedB.messageId,
            ],
          ),
        ).toEqual([{ count: 2 }]);
        process.stdout.write(
          `[ACCEPTANCE_CHECK] ${JSON.stringify({ name: "C1 different messageIds same idempotency key", inboxRows: 2, transactionRows: 1, ledgerRows: 2, outboxRows: 4, balance: "80.00" })}\n`,
        );
        process.stdout.write(
          `[ACCEPTANCE_CHECK] ${JSON.stringify({ name: "C4 concurrent SQS delivery", consumers: 2, financialEffects: 1 })}\n`,
        );

        const providerReplayA = makeEnvelope(
          `sqs-provider-replay-a-${randomUUID()}`,
          { ...sharedData, idempotencyKey: `other-key-a-${randomUUID()}` },
        );
        const providerReplayB = makeEnvelope(
          `sqs-provider-replay-b-${randomUUID()}`,
          { ...sharedData, idempotencyKey: `other-key-b-${randomUUID()}` },
        );
        await sendEnvelope(
          providerReplayA,
          `sqs-provider-group-a-${randomUUID()}`,
        );
        await sendEnvelope(
          providerReplayB,
          `sqs-provider-group-b-${randomUUID()}`,
        );
        const providerReplayConsumers = [providerReplayA, providerReplayB].map(
          () =>
            new WagerTransactionSqsConsumer(
              sqs,
              processor(),
              { ...environment, SQS_CONSUMER_MAX_MESSAGES: 1 },
              logger,
            ),
        );
        await Promise.all(
          providerReplayConsumers.map((instance) => instance.pollOnce()),
        );
        expect(
          await connection().execute(
            `select
               (select count(*)::integer from inbox_messages where consumer_name = ? and message_id in (?, ?, ?, ?)) as inbox,
               (select count(*)::integer from wager_transactions where external_transaction_id = ?) as transactions,
               (select count(*)::integer from wallet_ledger_entries where wallet_id = ?) as ledger,
               (select count(*)::integer from outbox_messages where payload->>'walletId' = ?) as outbox,
               (select balance from wallets where id = ?) as balance`,
            [
              "wager-transaction-consumer.v1",
              sharedA.messageId,
              sharedB.messageId,
              providerReplayA.messageId,
              providerReplayB.messageId,
              sharedData.externalTransactionId,
              sharedIdentityWallet.wallet.id,
              sharedIdentityWallet.wallet.id,
              sharedIdentityWallet.wallet.id,
            ],
          ),
        ).toEqual([
          { inbox: 4, transactions: 1, ledger: 2, outbox: 4, balance: "80.00" },
        ]);
        process.stdout.write(
          `[ACCEPTANCE_CHECK] ${JSON.stringify({ name: "C2 concurrent different Idempotency-Keys same provider identity", inboxRows: 4, transactionRows: 1, ledgerRows: 2, outboxRows: 4, balance: "80.00" })}\n`,
        );

        const divergentProviderWallet = await createFundedWallet("100.00");
        const divergentBase = makeData(
          divergentProviderWallet.playerId,
          divergentProviderWallet.wallet.id,
          `sqs-divergent-provider-${randomUUID()}`,
          `sqs-divergent-key-a-${randomUUID()}`,
          "BET",
          "10.00",
        );
        const divergentA = makeEnvelope(
          `sqs-divergent-a-${randomUUID()}`,
          divergentBase,
        );
        const divergentB = makeEnvelope(`sqs-divergent-b-${randomUUID()}`, {
          ...divergentBase,
          idempotencyKey: `sqs-divergent-key-b-${randomUUID()}`,
          money: { amount: "20.00", currency: "BRL" },
        });
        await sendEnvelope(divergentA, divergentProviderWallet.wallet.id);
        await consumer.pollOnce();
        await sendEnvelope(divergentB, divergentProviderWallet.wallet.id);
        await consumer.pollOnce();
        const providerConflictDeadLetter = await sqs.send(
          new ReceiveMessageCommand({
            QueueUrl: deadLetterQueueUrl,
            MaxNumberOfMessages: 10,
            WaitTimeSeconds: 0,
          }),
        );
        expect(
          providerConflictDeadLetter.Messages?.map((message) => message.Body),
        ).toContain(JSON.stringify(divergentB));
        expect(await receive()).toHaveLength(0);
        expect(
          await connection().execute(
            `select
               (select count(*)::integer from inbox_messages where consumer_name = ? and message_id in (?, ?)) as inbox,
               (select count(*)::integer from wager_transactions where external_transaction_id = ?) as transactions,
               (select count(*)::integer from wallet_ledger_entries where wallet_id = ?) as ledger,
               (select count(*)::integer from outbox_messages where payload->>'walletId' = ?) as outbox,
               (select balance from wallets where id = ?) as balance`,
            [
              "wager-transaction-consumer.v1",
              divergentA.messageId,
              divergentB.messageId,
              divergentBase.externalTransactionId,
              divergentProviderWallet.wallet.id,
              divergentProviderWallet.wallet.id,
              divergentProviderWallet.wallet.id,
            ],
          ),
        ).toEqual([
          { inbox: 1, transactions: 1, ledger: 2, outbox: 4, balance: "90.00" },
        ]);
        process.stdout.write(
          `[ACCEPTANCE_CHECK] ${JSON.stringify({ name: "C3 divergent payload for provider identity sent to DLQ", transactionRows: 1, ledgerRows: 2, outboxRows: 4, balance: "90.00", secondMessageInboxCommitted: false })}\n`,
        );

        const rejectedWallet = await createFundedWallet("0.00");
        const rejected = makeEnvelope(
          `sqs-rejected-${randomUUID()}`,
          makeData(
            rejectedWallet.playerId,
            rejectedWallet.wallet.id,
            `sqs-rejected-ext-${randomUUID()}`,
            `sqs-rejected-key-${randomUUID()}`,
          ),
        );
        await sendEnvelope(rejected);
        await consumer.pollOnce();
        expect(
          await connection().execute(
            "select status, failure_code from wager_transactions where idempotency_key = ?",
            [rejected.data.idempotencyKey],
          ),
        ).toEqual([{ status: "REJECTED", failure_code: "INSUFFICIENT_FUNDS" }]);
        expect(
          await connection().execute(
            "select processed_at from inbox_messages where message_id = ?",
            [rejected.messageId],
          ),
        ).toHaveLength(1);

        const pendingWallet = await createFundedWallet("50.00");
        const pending = makeEnvelope(
          `sqs-pending-${randomUUID()}`,
          makeData(
            pendingWallet.playerId,
            pendingWallet.wallet.id,
            `sqs-pending-ext-${randomUUID()}`,
            `sqs-pending-key-${randomUUID()}`,
            "REFUND",
            "10.00",
            `missing-ref-${randomUUID()}`,
          ),
        );
        await sendEnvelope(pending);
        await consumer.pollOnce();
        expect(
          await connection().execute(
            "select status from wager_transactions where idempotency_key = ?",
            [pending.data.idempotencyKey],
          ),
        ).toEqual([{ status: "PENDING_REFERENCE" }]);
        expect(
          await reconstructedWalletBalance(pendingWallet.wallet.id),
        ).toEqual({ amount: "50.00", currency: "BRL" });

        const invalidBody = "{invalid-json";
        await sqs.send(
          new SendMessageCommand({
            QueueUrl: queueUrl,
            MessageBody: invalidBody,
            MessageGroupId: "invalid-message-group",
            MessageDeduplicationId: randomUUID(),
          }),
        );
        await consumer.pollOnce();
        const deadLetterMessages = await sqs.send(
          new ReceiveMessageCommand({
            QueueUrl: deadLetterQueueUrl,
            MaxNumberOfMessages: 1,
            WaitTimeSeconds: 0,
          }),
        );
        expect(deadLetterMessages.Messages?.[0]?.Body).toBe(invalidBody);
        expect(await receive()).toHaveLength(0);

        const rollbackWallet = await createFundedWallet("100.00");
        const failureEnvelope = makeEnvelope(
          `sqs-fail-before-commit-${randomUUID()}`,
          makeData(
            rollbackWallet.playerId,
            rollbackWallet.wallet.id,
            `sqs-fail-ext-${randomUUID()}`,
            `sqs-fail-key-${randomUUID()}`,
          ),
        );
        const countsBeforeForcedFailure = await connection().execute(
          `select
             (select count(*)::integer from wager_transactions where wallet_id = ?) as transactions,
             (select count(*)::integer from wallet_ledger_entries where wallet_id = ?) as ledger,
             (select count(*)::integer from outbox_messages where aggregate_id = ?) as outbox`,
          [
            rollbackWallet.wallet.id,
            rollbackWallet.wallet.id,
            rollbackWallet.wallet.id,
          ],
        );
        await connection().execute(`
          create function reject_test_outbox_insert() returns trigger language plpgsql as $$
          begin raise exception 'database temporarily unavailable' using errcode = '57P03'; end;
          $$
        `);
        await connection().execute(`
          create trigger reject_test_outbox_insert before insert on outbox_messages
          for each row execute function reject_test_outbox_insert()
        `);
        try {
          await sendEnvelope(failureEnvelope);
          await consumer.pollOnce();
          expect(
            await connection().execute(
              "select count(*)::integer as count from inbox_messages where message_id = ?",
              [failureEnvelope.messageId],
            ),
          ).toEqual([{ count: 0 }]);
          expect(
            await reconstructedWalletBalance(rollbackWallet.wallet.id),
          ).toEqual({ amount: "100.00", currency: "BRL" });
          expect(
            await connection().execute(
              `select
                 (select count(*)::integer from wager_transactions where wallet_id = ?) as transactions,
                 (select count(*)::integer from wallet_ledger_entries where wallet_id = ?) as ledger,
                 (select count(*)::integer from outbox_messages where aggregate_id = ?) as outbox`,
              [
                rollbackWallet.wallet.id,
                rollbackWallet.wallet.id,
                rollbackWallet.wallet.id,
              ],
            ),
          ).toEqual(countsBeforeForcedFailure);
          await connection().execute(
            "drop trigger reject_test_outbox_insert on outbox_messages",
          );
          await connection().execute(
            "drop function reject_test_outbox_insert()",
          );
          let redelivered = (await receive())[0];
          for (
            let attempt = 0;
            redelivered === undefined && attempt < 12;
            attempt += 1
          ) {
            await new Promise((resolve) => setTimeout(resolve, 250));
            redelivered = (await receive())[0];
          }
          if (
            redelivered?.ReceiptHandle === undefined ||
            redelivered.Body !== JSON.stringify(failureEnvelope)
          ) {
            throw new Error("Transiently failed message was not redelivered");
          }
          await sqs.send(
            new ChangeMessageVisibilityCommand({
              QueueUrl: queueUrl,
              ReceiptHandle: redelivered.ReceiptHandle,
              VisibilityTimeout: 0,
            }),
          );
          await consumer.pollOnce();
          expect(
            await reconstructedWalletBalance(rollbackWallet.wallet.id),
          ).toEqual({ amount: "80.00", currency: "BRL" });
        } finally {
          await connection().execute(
            "drop trigger if exists reject_test_outbox_insert on outbox_messages",
          );
          await connection().execute(
            "drop function if exists reject_test_outbox_insert()",
          );
        }

        const crashWallet = await createFundedWallet("100.00");
        await commitAndRetry(
          makeEnvelope(
            `sqs-crash-after-commit-${randomUUID()}`,
            makeData(
              crashWallet.playerId,
              crashWallet.wallet.id,
              `sqs-crash-ext-${randomUUID()}`,
              `sqs-crash-key-${randomUUID()}`,
            ),
          ),
        );
        expect(await reconstructedWalletBalance(crashWallet.wallet.id)).toEqual(
          { amount: "80.00", currency: "BRL" },
        );
        const consumerMetricsText = await consumerMetricsRegistry.metrics();
        expect(consumerMetricsText).toMatch(
          /wagering_duplicates_total\{source="inbox"\} [1-9][0-9]*/,
        );
        expect(consumerMetricsText).toContain(
          'wagering_dlq_messages_total{reason="invalid_message"} 1',
        );
        expect(consumerMetricsText).toContain(
          'wagering_sqs_messages_total{outcome="handled"}',
        );
        expect(consumerMetricsText).toContain(
          'wagering_retries_total{component="sqs_consumer"}',
        );
      } finally {
        if (queueUrl !== undefined) {
          await sqs.send(new DeleteQueueCommand({ QueueUrl: queueUrl }));
        }
        if (deadLetterQueueUrl !== undefined) {
          await sqs.send(
            new DeleteQueueCommand({ QueueUrl: deadLetterQueueUrl }),
          );
        }
        sqs.destroy();
        consumerMetricsRegistry.clear();
      }
    },
  );

  test.skipIf(!sqsEnabled)(
    "publishes committed outbox events to FIFO with retries and multi-publisher claims",
    async () => {
      const environment = parseEnvironment(process.env);
      const sqs = new SQSClient({
        region: environment.AWS_REGION,
        endpoint: environment.SQS_ENDPOINT,
        credentials: {
          accessKeyId: environment.AWS_ACCESS_KEY_ID,
          secretAccessKey: environment.AWS_SECRET_ACCESS_KEY,
        },
      });
      const queueName = `wager-events-test-${randomUUID().replaceAll("-", "").slice(0, 16)}.fifo`;
      let queueUrl: string | undefined;
      const metricsRegistry = new Registry();
      const wageringMetrics = new WageringMetrics(metricsRegistry);
      const store = new MikroOrmOutboxPublishingStore(orm);
      const retry = { baseDelayMs: 1000, maxDelayMs: 5000, batchSize: 10 };
      const now = new Date();
      const putOutbox = async (
        id: string,
        aggregateId: string,
        occurredAt = new Date(now.getTime()),
      ) =>
        connection().execute(
          `insert into outbox_messages
           (id, aggregate_id, event_type, payload, occurred_at, attempts, next_attempt_at)
           values (?, ?, 'wager.transaction.processed.v1', ?, ?, 0, ?)`,
          [
            id,
            aggregateId,
            JSON.stringify({ money: { amount: "20.00", currency: "BRL" } }),
            occurredAt,
            instant,
          ],
        );

      try {
        const created = await sqs.send(
          new CreateQueueCommand({
            QueueName: queueName,
            Attributes: {
              FifoQueue: "true",
              ContentBasedDeduplication: "false",
            },
          }),
        );
        queueUrl = created.QueueUrl;
        if (queueUrl === undefined)
          throw new Error("Test queue was not created");

        await connection().execute(
          "update outbox_messages set published_at = ? where published_at is null",
          [now],
        );

        const firstId = `publisher-first-${randomUUID()}`;
        const secondId = `publisher-second-${randomUUID()}`;
        const otherIds = Array.from(
          { length: 4 },
          () => `publisher-other-${randomUUID()}`,
        );
        const sharedAggregate = `publisher-aggregate-${randomUUID()}`;
        await putOutbox(firstId, sharedAggregate, new Date(now.getTime() - 2));
        await putOutbox(secondId, sharedAggregate, new Date(now.getTime() - 1));
        for (const id of otherIds) {
          await putOutbox(id, `publisher-aggregate-${randomUUID()}`);
        }

        const queue = new AwsSqsIntegrationEventQueue(sqs, {
          ...environment,
          SQS_WAGER_EVENTS_QUEUE_NAME: queueName,
        });
        let releaseFirstClaims: (() => void) | undefined;
        const firstClaimsReachedQueue = new Promise<void>((resolve) => {
          releaseFirstClaims = resolve;
        });
        let concurrentSends = 0;
        let observedLag = 0;
        const concurrentQueue: IntegrationEventQueue = {
          publish: async (event) => {
            const metricsText = await metricsRegistry.metrics();
            const lagMatch = metricsText.match(
              /^wagering_outbox_lag_seconds ([0-9.]+)$/m,
            );
            observedLag = Math.max(observedLag, Number(lagMatch?.[1] ?? "0"));
            concurrentSends += 1;
            if (concurrentSends === 2) releaseFirstClaims?.();
            if (concurrentSends <= 2) await firstClaimsReachedQueue;
            await queue.publish(event);
          },
        };
        const firstPublisher = new PublishOutboxMessages(
          store,
          concurrentQueue,
          { ...retry, batchSize: 3 },
          wageringMetrics,
        );
        const secondPublisher = new PublishOutboxMessages(
          store,
          concurrentQueue,
          { ...retry, batchSize: 3 },
          wageringMetrics,
        );
        const [firstBatch, secondBatch] = await Promise.all([
          firstPublisher.runBatch(now),
          secondPublisher.runBatch(now),
        ]);
        expect(firstBatch.outcomes).toHaveLength(3);
        expect(secondBatch.outcomes).toHaveLength(3);
        expect(observedLag).toBeGreaterThan(0);
        await firstPublisher.runBatch(now);
        expect(await metricsRegistry.metrics()).toContain(
          "wagering_outbox_lag_seconds 0",
        );
        expect(await metricsRegistry.metrics()).toContain(
          'wagering_outbox_publish_total{outcome="success"} 6',
        );
        const publishedIds = [firstId, secondId, ...otherIds];
        const statuses = await connection().execute(
          `select id, published_at from outbox_messages where id in (${publishedIds.map(() => "?").join(", ")}) order by id`,
          publishedIds,
        );
        expect(statuses).toHaveLength(6);
        expect(
          (statuses as Array<{ published_at: Date | string | null }>).every(
            (row) => row.published_at !== null,
          ),
        ).toBe(true);

        const received = await sqs.send(
          new ReceiveMessageCommand({
            QueueUrl: queueUrl,
            MaxNumberOfMessages: 10,
            WaitTimeSeconds: 0,
          }),
        );
        const envelopes = (received.Messages ?? []).map(
          (message) =>
            JSON.parse(message.Body ?? "{}") as {
              id: string;
              aggregateId: string;
              eventType: string;
              occurredAt: string;
              payload: { money: { amount: string; currency: string } };
            },
        );
        expect(envelopes.map((event) => event.id).sort()).toEqual(
          publishedIds.sort(),
        );
        expect(
          envelopes
            .filter((event) => event.aggregateId === sharedAggregate)
            .map((event) => event.id),
        ).toEqual([firstId, secondId]);
        expect(envelopes[0]?.payload.money).toEqual({
          amount: "20.00",
          currency: "BRL",
        });
        expect(envelopes.find((event) => event.id === firstId)?.eventType).toBe(
          "wager.transaction.processed.v1",
        );

        const retryId = `publisher-retry-${randomUUID()}`;
        await putOutbox(retryId, `publisher-retry-aggregate-${randomUUID()}`);
        const failingQueue = new AwsSqsIntegrationEventQueue(sqs, {
          ...environment,
          SQS_WAGER_EVENTS_QUEUE_NAME: `missing-events-${randomUUID()}.fifo`,
        });
        const failedBatch = await new PublishOutboxMessages(
          store,
          failingQueue,
          retry,
          wageringMetrics,
        ).runBatch(now);
        expect(failedBatch.outcomes).toContainEqual(
          expect.objectContaining({
            id: retryId,
            attempts: 1,
            published: false,
          }),
        );
        const retryStateRows = await connection().execute(
          "select attempts, next_attempt_at, published_at from outbox_messages where id = ?",
          [retryId],
        );
        const retryState = retryStateRows[0] as {
          attempts: number;
          next_attempt_at: Date | string;
          published_at: Date | string | null;
        };
        expect(retryState.attempts).toBe(1);
        expect(new Date(retryState.next_attempt_at).getTime()).toBe(
          now.getTime() + 2000,
        );
        expect(retryState.published_at).toBeNull();
        expect(await metricsRegistry.metrics()).toContain(
          'wagering_outbox_publish_total{outcome="failure"} 1',
        );
        await connection().execute(
          "update outbox_messages set next_attempt_at = ? where id = ?",
          [now, retryId],
        );
        const retryQueue = new AwsSqsIntegrationEventQueue(sqs, {
          ...environment,
          SQS_WAGER_EVENTS_QUEUE_NAME: queueName,
        });
        await new PublishOutboxMessages(store, retryQueue, retry).runBatch(now);
        const retryPublishedRows = await connection().execute(
          "select published_at from outbox_messages where id = ?",
          [retryId],
        );
        expect(
          new Date(
            (retryPublishedRows[0] as { published_at: string }).published_at,
          ).getTime(),
        ).toBe(now.getTime());

        const beforeSendCrashId = `publisher-before-send-crash-${randomUUID()}`;
        await putOutbox(
          beforeSendCrashId,
          `publisher-before-send-aggregate-${randomUUID()}`,
        );
        await connection().execute(`
          create function reject_outbox_pre_send_retry() returns trigger language plpgsql as $$
          begin
            if old.id = '${beforeSendCrashId}' then
              raise exception 'forced crash before SQS send';
            end if;
            return new;
          end;
          $$
        `);
        await connection().execute(`
          create trigger reject_outbox_pre_send_retry_trigger
          before update on outbox_messages
          for each row execute function reject_outbox_pre_send_retry()
        `);
        try {
          await expect(
            new PublishOutboxMessages(
              store,
              {
                publish: async () => {
                  throw new Error("SimulatedProcessCrash");
                },
              },
              retry,
            ).runBatch(now),
          ).rejects.toThrow();
        } finally {
          await connection().execute(
            "drop trigger reject_outbox_pre_send_retry_trigger on outbox_messages",
          );
          await connection().execute(
            "drop function reject_outbox_pre_send_retry()",
          );
        }
        expect(
          await connection().execute(
            "select attempts, published_at from outbox_messages where id = ?",
            [beforeSendCrashId],
          ),
        ).toEqual([{ attempts: 0, published_at: null }]);
        const beforeSendRetry = await new PublishOutboxMessages(
          store,
          new AwsSqsIntegrationEventQueue(sqs, {
            ...environment,
            SQS_WAGER_EVENTS_QUEUE_NAME: queueName,
          }),
          retry,
        ).runBatch(now);
        expect(beforeSendRetry.outcomes).toContainEqual(
          expect.objectContaining({ id: beforeSendCrashId, published: true }),
        );

        const crashId = `publisher-crash-${randomUUID()}`;
        await putOutbox(crashId, `publisher-crash-aggregate-${randomUUID()}`);
        await connection().execute(`
          create function reject_outbox_publish_marker() returns trigger language plpgsql as $$
          begin
            if old.id = '${crashId}' then
              raise exception 'forced crash after SQS send';
            end if;
            return new;
          end;
          $$
        `);
        await connection().execute(`
          create trigger reject_outbox_publish_marker_trigger
          before update on outbox_messages
          for each row execute function reject_outbox_publish_marker()
        `);
        const recordedIds: string[] = [];
        const recordingQueue: IntegrationEventQueue = {
          publish: async (event) => {
            recordedIds.push(event.id);
            await new AwsSqsIntegrationEventQueue(sqs, {
              ...environment,
              SQS_WAGER_EVENTS_QUEUE_NAME: queueName,
            }).publish(event);
          },
        };
        try {
          await expect(
            new PublishOutboxMessages(store, recordingQueue, retry).runBatch(
              now,
            ),
          ).rejects.toThrow();
        } finally {
          await connection().execute(
            "drop trigger reject_outbox_publish_marker_trigger on outbox_messages",
          );
          await connection().execute(
            "drop function reject_outbox_publish_marker()",
          );
        }
        expect(
          await connection().execute(
            "select attempts, published_at from outbox_messages where id = ?",
            [crashId],
          ),
        ).toEqual([{ attempts: 0, published_at: null }]);
        await new PublishOutboxMessages(store, recordingQueue, retry).runBatch(
          now,
        );
        expect(recordedIds).toEqual([crashId, crashId]);
        const crashPublishedRows = await connection().execute(
          "select published_at from outbox_messages where id = ?",
          [crashId],
        );
        expect(
          new Date(
            (crashPublishedRows[0] as { published_at: string }).published_at,
          ).getTime(),
        ).toBe(now.getTime());

        const rolledBackEventId = `publisher-rollback-${randomUUID()}`;
        await expect(
          orm.em.fork({ clear: true }).transactional(async (em) => {
            await em.getConnection().execute(
              `insert into outbox_messages
               (id, aggregate_id, event_type, payload, occurred_at, attempts, next_attempt_at)
               values (?, ?, 'wager.transaction.processed.v1', ?, ?, 0, ?)`,
              [
                rolledBackEventId,
                `publisher-rollback-aggregate-${randomUUID()}`,
                JSON.stringify({ money: { amount: "1.00", currency: "BRL" } }),
                now,
                instant,
              ],
              "run",
              em.getTransactionContext(),
            );
            throw new Error("Forced financial rollback");
          }),
        ).rejects.toThrow("Forced financial rollback");
        const emptyPublishBatch = await new PublishOutboxMessages(
          store,
          new AwsSqsIntegrationEventQueue(sqs, {
            ...environment,
            SQS_WAGER_EVENTS_QUEUE_NAME: queueName,
          }),
          retry,
        ).runBatch(now);
        expect(emptyPublishBatch.outcomes).toEqual([]);
        expect(
          await connection().execute(
            "select count(*)::integer as count from outbox_messages where id = ?",
            [rolledBackEventId],
          ),
        ).toEqual([{ count: 0 }]);
      } finally {
        if (queueUrl !== undefined) {
          await sqs.send(new DeleteQueueCommand({ QueueUrl: queueUrl }));
        }
        sqs.destroy();
      }
    },
  );

  test("accepts valid wallet, transaction, ledger, inbox and outbox rows", async () => {
    await createWallet("valid-wallet");
    await createTransaction("valid-transaction", "valid-wallet");
    await createLedger("valid-ledger", "valid-wallet", "valid-transaction");
    await connection().execute(
      "insert into inbox_messages (message_id, consumer_name, payload_hash, received_at) values ('valid-message', 'consumer', 'hash', ?)",
      [instant],
    );
    await connection().execute(
      "insert into outbox_messages (id, aggregate_id, event_type, payload, occurred_at, attempts, next_attempt_at) values ('valid-outbox', 'valid-wallet', 'Created', ?, ?, 0, ?)",
      [{ event: "created" }, instant, instant],
    );
    expect(
      await connection().execute(
        "select count(*)::integer as count from wallets where id = 'valid-wallet'",
      ),
    ).toEqual([{ count: 1 }]);
  });

  test("stores the NUMERIC(20,2) maximum exactly and rejects overflow", async () => {
    await connection().execute(
      "insert into wallets values ('maximum-wallet', 'maximum-player', 'BRL', ?, 1, ?, ?)",
      ["999999999999999999.99", instant, instant],
    );
    expect(
      await connection().execute(
        "select balance from wallets where id = 'maximum-wallet'",
      ),
    ).toEqual([{ balance: "999999999999999999.99" }]);
    await expect(
      connection().execute(
        "insert into wallets values ('overflow-wallet', 'overflow-player', 'BRL', ?, 1, ?, ?)",
        ["1000000000000000000.00", instant, instant],
      ),
    ).rejects.toThrow();
  });

  test("rejects negative wallet balance, duplicate player currency and invalid version", async () => {
    await expect(
      connection().execute(
        "insert into wallets values ('negative-wallet', 'negative-player', 'BRL', '-1.00', 1, ?, ?)",
        [instant, instant],
      ),
    ).rejects.toThrow();
    await expect(
      createWallet("duplicate-wallet", "valid-wallet"),
    ).rejects.toThrow();
    await expect(
      connection().execute(
        "insert into wallets values ('bad-version', 'version-player', 'BRL', '0.00', 0, ?, ?)",
        [instant, instant],
      ),
    ).rejects.toThrow();
  });

  test("rejects duplicate idempotency and provider transaction keys", async () => {
    await expect(
      createTransaction(
        "duplicate-idempotency",
        "valid-wallet",
        "valid-transaction",
      ),
    ).rejects.toThrow();
    await expect(
      createTransaction(
        "duplicate-provider",
        "valid-wallet",
        "new-key",
        "valid-transaction",
      ),
    ).rejects.toThrow();
  });

  test("requires transaction player and currency to match its wallet", async () => {
    await createWallet("identity-wallet", "identity-player");
    await expect(
      createTransaction(
        "wrong-player-transaction",
        "identity-wallet",
        "wrong-player-key",
        "wrong-player-external",
        "different-player",
      ),
    ).rejects.toThrow();
    await expect(
      createTransaction(
        "wrong-currency-transaction",
        "identity-wallet",
        "wrong-currency-key",
        "wrong-currency-external",
        "identity-player",
        "USD",
      ),
    ).rejects.toThrow();
    await createTransaction(
      "matching-identity-transaction",
      "identity-wallet",
      "matching-identity-key",
      "matching-identity-external",
      "identity-player",
    );
  });

  test("requires ledger wallet and currency to match its transaction and wallet", async () => {
    await createWallet("other-wallet", "other-player");
    await expect(
      createLedger(
        "wrong-ledger-currency",
        "valid-wallet",
        "valid-transaction",
        "CREDIT",
        "20.00",
        "100.00",
        "120.00",
        "USD",
      ),
    ).rejects.toThrow();

    await createTransaction(
      "other-wallet-transaction",
      "other-wallet",
      "other-wallet-key",
      "other-wallet-external",
      "other-player",
    );
    await expect(
      createLedger(
        "wrong-ledger-wallet",
        "valid-wallet",
        "other-wallet-transaction",
      ),
    ).rejects.toThrow();
    await expect(
      createLedger(
        "matching-other-ledger",
        "other-wallet",
        "other-wallet-transaction",
      ),
    ).resolves.toBeUndefined();
  });

  test("allows distinct internal OPENING transactions with null provider metadata", async () => {
    for (const id of ["opening-one", "opening-two"]) {
      await connection().execute(
        `insert into wager_transactions (
          id, idempotency_key, payload_hash, wallet_id, player_id, kind, status,
          amount, currency, created_at, updated_at
        ) values (?, ?, 'opening-hash', 'valid-wallet', 'valid-wallet', 'OPENING',
          'PENDING', '0.00', 'BRL', ?, ?)`,
        [id, id, instant, instant],
      );
    }
    expect(
      await connection().execute(
        "select count(*)::integer as count from wager_transactions where id in ('opening-one', 'opening-two')",
      ),
    ).toEqual([{ count: 2 }]);
  });

  test("rejects invalid transaction state, kind, amount and missing reference", async () => {
    await expect(
      connection().execute(
        "update wager_transactions set kind = 'OTHER' where id = 'valid-transaction'",
      ),
    ).rejects.toThrow();
    await expect(
      connection().execute(
        "update wager_transactions set amount = '-1.00' where id = 'valid-transaction'",
      ),
    ).rejects.toThrow();
    await expect(
      connection().execute(
        "update wager_transactions set reference_retry_attempts = -1 where id = 'valid-transaction'",
      ),
    ).rejects.toThrow();
    await expect(
      connection().execute(
        "update wager_transactions set reference_next_attempt_at = ? where id = 'valid-transaction'",
        [instant],
      ),
    ).rejects.toThrow();
    await expect(
      connection().execute(
        "update wager_transactions set status = 'REJECTED', failure_code = 'INSUFFICIENT_FUNDS', processed_at = ?, updated_at = ?, reference_next_attempt_at = ? where id = 'valid-transaction'",
        [instant, instant, instant],
      ),
    ).rejects.toThrow();
    await expect(
      connection().execute(
        "update wager_transactions set status = 'PROCESSED' where id = 'valid-transaction'",
      ),
    ).rejects.toThrow();
    await expect(
      connection().execute(
        "update wager_transactions set kind = 'REFUND' where id = 'valid-transaction'",
      ),
    ).rejects.toThrow();
    for (const status of ["REJECTED", "FAILED"]) {
      await expect(
        connection().execute(
          "update wager_transactions set status = ?, processed_at = ?, updated_at = ? where id = 'valid-transaction'",
          [status, instant, instant],
        ),
      ).rejects.toThrow();
    }
  });

  test("enforces resulting balance consistency for transaction status", async () => {
    await createWallet("resulting-balance-wallet", "resulting-balance-player");
    await createTransaction(
      "resulting-balance-transaction",
      "resulting-balance-wallet",
      "resulting-balance-key",
      "resulting-balance-external",
      "resulting-balance-player",
    );
    await expect(
      connection().execute(
        "update wager_transactions set status = 'PROCESSED', processed_at = ?, updated_at = ? where id = 'resulting-balance-transaction'",
        [instant, instant],
      ),
    ).rejects.toThrow();
    await expect(
      connection().execute(
        "update wager_transactions set status = 'PROCESSED', resulting_balance = '-1.00', processed_at = ?, updated_at = ? where id = 'resulting-balance-transaction'",
        [instant, instant],
      ),
    ).rejects.toThrow();
    await expect(
      connection().execute(
        "update wager_transactions set resulting_balance = '1.00' where id = 'resulting-balance-transaction'",
      ),
    ).rejects.toThrow();
    await expect(
      connection().execute(
        "update wager_transactions set kind = 'REFUND', reference_external_transaction_id = 'original-external', status = 'PENDING_REFERENCE', resulting_balance = '1.00' where id = 'resulting-balance-transaction'",
      ),
    ).rejects.toThrow();
  });

  test("rejects zero and negative ledger amounts and inconsistent balances", async () => {
    await expect(
      createLedger(
        "zero-ledger",
        "valid-wallet",
        "valid-transaction",
        "CREDIT",
        "0.00",
      ),
    ).rejects.toThrow();
    await expect(
      createLedger(
        "negative-ledger",
        "valid-wallet",
        "valid-transaction",
        "CREDIT",
        "-1.00",
      ),
    ).rejects.toThrow();
    await expect(
      createLedger(
        "bad-credit",
        "valid-wallet",
        "valid-transaction",
        "CREDIT",
        "20.00",
        "100.00",
        "119.99",
      ),
    ).rejects.toThrow();
    await expect(
      createLedger(
        "bad-debit",
        "valid-wallet",
        "valid-transaction",
        "DEBIT",
        "20.00",
        "100.00",
        "80.01",
      ),
    ).rejects.toThrow();
  });

  test("rejects duplicate ledger for a transaction and wallet", async () => {
    await expect(
      createLedger("duplicate-ledger", "valid-wallet", "valid-transaction"),
    ).rejects.toThrow();
  });

  test("rejects ledger updates and deletes", async () => {
    await expect(
      connection().execute(
        "update wallet_ledger_entries set amount = '21.00' where id = 'valid-ledger'",
      ),
    ).rejects.toThrow("Wallet ledger entries are immutable");
    await expect(
      connection().execute(
        "delete from wallet_ledger_entries where id = 'valid-ledger'",
      ),
    ).rejects.toThrow("Wallet ledger entries are immutable");
  });

  test("rejects duplicate inbox message within a consumer", async () => {
    await expect(
      connection().execute(
        "insert into inbox_messages (message_id, consumer_name, payload_hash, received_at) values ('valid-message', 'consumer', 'hash', ?)",
        [instant],
      ),
    ).rejects.toThrow();
    await connection().execute(
      "insert into inbox_messages (message_id, consumer_name, payload_hash, received_at) values ('valid-message', 'other-consumer', 'hash', ?)",
      [instant],
    );
  });

  test("rejects negative outbox attempts", async () => {
    await expect(
      connection().execute(
        "update outbox_messages set attempts = -1 where id = 'valid-outbox'",
      ),
    ).rejects.toThrow();
  });

  test("maps decimal strings and rehydrates approved domain objects", async () => {
    const em = orm.em.fork();
    const wallet = await em.findOneOrFail(WalletRecord, "valid-wallet");
    const transaction = await em.findOneOrFail(
      WagerTransactionRecord,
      "valid-transaction",
    );
    const ledger = await em.findOneOrFail(
      WalletLedgerEntryRecord,
      "valid-ledger",
    );
    expect(typeof wallet.balance).toBe("string");
    expect(typeof transaction.amount).toBe("string");
    expect(typeof ledger.balanceBefore).toBe("string");
    expect(walletFromRecord(wallet).balance.toJSON().amount).toBe("100.00");
    expect(wagerTransactionFromRecord(transaction).money.toJSON().amount).toBe(
      "20.00",
    );
    expect(walletLedgerEntryFromRecord(ledger).money.toJSON().amount).toBe(
      "20.00",
    );
    expect(
      await em.findOneOrFail(InboxMessageRecord, {
        consumerName: "consumer",
        messageId: "valid-message",
      }),
    ).toBeDefined();
    expect(
      await em.findOneOrFail(OutboxMessageRecord, "valid-outbox"),
    ).toBeDefined();
  });

  test("persists and reloads domain records through isolated MikroORM forks", async () => {
    const writer = orm.em.fork();
    const money = Money.from({ amount: "20.00", currency: "BRL" });
    const before = Money.from({ amount: "100.00", currency: "BRL" });
    const wallet = Wallet.open(
      {
        id: "mapped-wallet",
        playerId: "mapped-player",
        currency: "BRL",
        balance: before,
      },
      instant,
    );
    const transaction = WagerTransaction.create(
      {
        id: "mapped-transaction",
        providerId: "mapped-provider",
        externalTransactionId: "mapped-external",
        idempotencyKey: "mapped-key",
        payloadHash: "mapped-hash",
        walletId: wallet.id,
        playerId: wallet.playerId,
        roundId: "mapped-round",
        gameId: "mapped-game",
        kind: WagerTransactionKind.BET,
        money,
      },
      instant,
    );
    const ledger = WalletLedgerEntry.create(
      {
        id: "mapped-ledger",
        walletId: wallet.id,
        transactionId: transaction.id,
        direction: LedgerDirection.CREDIT,
        money,
        balanceBefore: before,
        balanceAfter: before.add(money),
      },
      instant,
    );
    await writer.persist(walletToRecord(wallet)).flush();
    await writer.persist(wagerTransactionToRecord(transaction)).flush();
    await writer.persist(walletLedgerEntryToRecord(ledger)).flush();

    const reader = orm.em.fork();
    const loadedWallet = walletFromRecord(
      await reader.findOneOrFail(WalletRecord, wallet.id),
    );
    const loadedTransaction = wagerTransactionFromRecord(
      await reader.findOneOrFail(WagerTransactionRecord, transaction.id),
    );
    const loadedLedger = walletLedgerEntryFromRecord(
      await reader.findOneOrFail(WalletLedgerEntryRecord, ledger.id),
    );
    expect(loadedWallet.balance.toJSON().amount).toBe("100.00");
    expect(loadedWallet.version).toBe(1);
    expect(loadedTransaction.money.toJSON().amount).toBe("20.00");
    expect(loadedLedger.balanceAfter.toJSON().amount).toBe("120.00");
  });

  test("processes BET, WIN and LOSS with atomic financial records", async () => {
    const { playerId, wallet } = await createFundedWallet("100.00");
    const useCase = processor();

    const bet = await useCase.execute(
      processInput(wallet, WagerTransactionKind.BET, "20.00"),
    );
    expect(bet.status).toBe(WagerTransactionStatus.PROCESSED);
    expect(bet.resultingBalance).toEqual({ amount: "80.00", currency: "BRL" });
    expect(await readWallet(wallet.id)).toEqual({
      balance: "80.00",
      version: "2",
    });
    expect(await outboxCountForTransaction(bet.transactionId)).toBe(2);

    const win = await useCase.execute(
      processInput(wallet, WagerTransactionKind.WIN, "30.00"),
    );
    expect(win.status).toBe(WagerTransactionStatus.PROCESSED);
    expect(win.resultingBalance).toEqual({ amount: "110.00", currency: "BRL" });
    expect(await readWallet(wallet.id)).toEqual({
      balance: "110.00",
      version: "3",
    });
    expect(await outboxCountForTransaction(win.transactionId)).toBe(2);

    const loss = await useCase.execute(
      processInput(wallet, WagerTransactionKind.LOSS, "30.00"),
    );
    expect(loss.status).toBe(WagerTransactionStatus.PROCESSED);
    expect(loss.resultingBalance).toEqual({
      amount: "110.00",
      currency: "BRL",
    });
    expect(await readWallet(wallet.id)).toEqual({
      balance: "110.00",
      version: "3",
    });
    expect(await outboxCountForTransaction(loss.transactionId)).toBe(1);

    const counts = await countsForPlayer(playerId);
    expect(counts).toEqual({
      wallets: 1,
      transactions: 4,
      ledger: 3,
      outbox: 7,
    });
    expect(await reconstructedBalance(playerId)).toEqual({
      amount: "110.00",
      currency: "BRL",
    });
  });

  test("replays the original persisted result without reading the current wallet balance", async () => {
    const { playerId, wallet } = await createFundedWallet("100.00");
    const useCase = processor();
    const betInput = processInput(wallet, WagerTransactionKind.BET, "20.00");
    const original = await useCase.execute(betInput);
    const replay = await useCase.execute(betInput);
    expect(replay.idempotentReplay).toBe(true);
    expect(replay.transactionId).toBe(original.transactionId);
    expect(replay.resultingBalance).toEqual({
      amount: "80.00",
      currency: "BRL",
    });

    await useCase.execute(
      processInput(wallet, WagerTransactionKind.WIN, "5.00"),
    );
    expect(await readWallet(wallet.id)).toEqual({
      balance: "85.00",
      version: "3",
    });
    const replayAfterChange = await useCase.execute(betInput);
    expect(replayAfterChange.idempotentReplay).toBe(true);
    expect(replayAfterChange.resultingBalance).toEqual({
      amount: "80.00",
      currency: "BRL",
    });
    expect(await countsForPlayer(playerId)).toEqual({
      wallets: 1,
      transactions: 3,
      ledger: 3,
      outbox: 6,
    });
    expect(await reconstructedBalance(playerId)).toEqual({
      amount: "85.00",
      currency: "BRL",
    });
  });

  test("rejects divergent idempotency payloads and replays business rejection", async () => {
    const { playerId, wallet } = await createFundedWallet("10.00");
    const useCase = processor();
    const rejectedInput = processInput(
      wallet,
      WagerTransactionKind.BET,
      "20.00",
    );
    const rejected = await useCase.execute(rejectedInput);
    expect(rejected.status).toBe(WagerTransactionStatus.REJECTED);
    expect(rejected.failureCode).toBe(
      WagerTransactionRejectionCode.INSUFFICIENT_FUNDS,
    );
    const rejectedReplay = await useCase.execute(rejectedInput);
    expect(rejectedReplay.idempotentReplay).toBe(true);
    expect(rejectedReplay.transactionId).toBe(rejected.transactionId);
    expect(rejectedReplay.failureCode).toBe(
      WagerTransactionRejectionCode.INSUFFICIENT_FUNDS,
    );
    expect(rejectedReplay.resultingBalance).toBeNull();

    await expect(
      useCase.execute({
        ...rejectedInput,
        money: { amount: "21.00", currency: "BRL" },
      }),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
    await expect(
      useCase.execute({ ...rejectedInput, kind: WagerTransactionKind.LOSS }),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
    expect(await countsForPlayer(playerId)).toEqual({
      wallets: 1,
      transactions: 2,
      ledger: 1,
      outbox: 3,
    });
    expect(await readWallet(wallet.id)).toEqual({
      balance: "10.00",
      version: "1",
    });
    expect(await reconstructedBalance(playerId)).toEqual({
      amount: "10.00",
      currency: "BRL",
    });
  });

  test("replays an insufficient-funds rejection after the wallet later has enough funds", async () => {
    const { playerId, wallet } = await createFundedWallet("10.00");
    const useCase = processor();
    const rejectedInput = processInput(
      wallet,
      WagerTransactionKind.BET,
      "20.00",
    );

    const rejected = await useCase.execute(rejectedInput);
    expect(rejected.status).toBe(WagerTransactionStatus.REJECTED);
    expect(rejected.failureCode).toBe(
      WagerTransactionRejectionCode.INSUFFICIENT_FUNDS,
    );
    expect(rejected.resultingBalance).toBeNull();

    const win = await useCase.execute(
      processInput(wallet, WagerTransactionKind.WIN, "20.00"),
    );
    expect(win.status).toBe(WagerTransactionStatus.PROCESSED);
    expect(await readWallet(wallet.id)).toEqual({
      balance: "30.00",
      version: "2",
    });

    const beforeReplay = await countsForPlayer(playerId);
    const replay = await useCase.execute(rejectedInput);

    expect(replay.idempotentReplay).toBe(true);
    expect(replay.status).toBe(WagerTransactionStatus.REJECTED);
    expect(replay.transactionId).toBe(rejected.transactionId);
    expect(replay.failureCode).toBe(
      WagerTransactionRejectionCode.INSUFFICIENT_FUNDS,
    );
    expect(replay.resultingBalance).toBeNull();
    expect(await readWallet(wallet.id)).toEqual({
      balance: "30.00",
      version: "2",
    });
    expect(await countsForPlayer(playerId)).toEqual(beforeReplay);
    expect(await reconstructedBalance(playerId)).toEqual({
      amount: "30.00",
      currency: "BRL",
    });
  });

  test("replays the same provider transaction with a different idempotency key", async () => {
    const { playerId, wallet } = await createFundedWallet("100.00");
    const useCase = processor();
    const firstInput = processInput(wallet, WagerTransactionKind.BET, "20.00");
    const first = await useCase.execute(firstInput);
    const second = await useCase.execute({
      ...firstInput,
      idempotencyKey: `different-key-${randomUUID()}`,
    });

    expect(second.idempotentReplay).toBe(true);
    expect(second.transactionId).toBe(first.transactionId);
    expect(second.resultingBalance).toEqual({
      amount: "80.00",
      currency: "BRL",
    });
    expect(await countsForPlayer(playerId)).toEqual({
      wallets: 1,
      transactions: 2,
      ledger: 2,
      outbox: 4,
    });
    expect(await outboxCountForTransaction(first.transactionId)).toBe(2);
    expect(await readWallet(wallet.id)).toEqual({
      balance: "80.00",
      version: "2",
    });
    expect(await reconstructedBalance(playerId)).toEqual({
      amount: "80.00",
      currency: "BRL",
    });
  });

  test("rejects a provider transaction duplicate with a different business payload", async () => {
    const { playerId, wallet } = await createFundedWallet("100.00");
    const useCase = processor();
    const firstInput = processInput(wallet, WagerTransactionKind.BET, "20.00");
    const first = await useCase.execute(firstInput);
    await expect(
      useCase.execute({
        ...firstInput,
        idempotencyKey: `different-key-${randomUUID()}`,
        money: { amount: "21.00", currency: "BRL" },
      }),
    ).rejects.toThrow("Provider transaction already exists");

    expect(await countsForPlayer(playerId)).toEqual({
      wallets: 1,
      transactions: 2,
      ledger: 2,
      outbox: 4,
    });
    expect(await outboxCountForTransaction(first.transactionId)).toBe(2);
    expect(await readWallet(wallet.id)).toEqual({
      balance: "80.00",
      version: "2",
    });
    expect(await reconstructedBalance(playerId)).toEqual({
      amount: "80.00",
      currency: "BRL",
    });
  });

  test("replays concurrent provider duplicates with different idempotency keys", async () => {
    const { playerId, wallet } = await createFundedWallet("100.00");
    const useCase = processor();
    const firstInput = processInput(wallet, WagerTransactionKind.BET, "20.00");
    const results = await Promise.all([
      useCase.execute(firstInput),
      useCase.execute({
        ...firstInput,
        idempotencyKey: `different-key-${randomUUID()}`,
      }),
    ]);

    expect(results.filter((result) => !result.idempotentReplay)).toHaveLength(
      1,
    );
    expect(results.filter((result) => result.idempotentReplay)).toHaveLength(1);
    expect(new Set(results.map((result) => result.transactionId)).size).toBe(1);
    expect(await countsForPlayer(playerId)).toEqual({
      wallets: 1,
      transactions: 2,
      ledger: 2,
      outbox: 4,
    });
    expect(await readWallet(wallet.id)).toEqual({
      balance: "80.00",
      version: "2",
    });
    expect(await reconstructedBalance(playerId)).toEqual({
      amount: "80.00",
      currency: "BRL",
    });
  });

  test("serializes fifty identical concurrent BET requests through persistent idempotency", async () => {
    const { playerId, wallet } = await createFundedWallet("100.00");
    const useCase = processor();
    const input = processInput(wallet, WagerTransactionKind.BET, "20.00");
    const results = await Promise.all(
      Array.from({ length: 50 }, () => useCase.execute(input)),
    );
    expect(results.filter((result) => !result.idempotentReplay)).toHaveLength(
      1,
    );
    expect(results.filter((result) => result.idempotentReplay)).toHaveLength(
      49,
    );
    expect(new Set(results.map((result) => result.transactionId)).size).toBe(1);
    expect(await readWallet(wallet.id)).toEqual({
      balance: "80.00",
      version: "2",
    });
    expect(await countsForPlayer(playerId)).toEqual({
      wallets: 1,
      transactions: 2,
      ledger: 2,
      outbox: 4,
    });
    expect(await reconstructedBalance(playerId)).toEqual({
      amount: "80.00",
      currency: "BRL",
    });
  });

  test("recovers a cross-wallet idempotency unique race outside the aborted transaction", async () => {
    const [first, second] = await Promise.all([
      createFundedWallet("50.00"),
      createFundedWallet("50.00"),
    ]);
    const delegate = new MikroOrmWagerTransactionProcessingStore(orm);
    let callbackCount = 0;
    let releaseCallbacks: (() => void) | undefined;
    const callbacksReady = new Promise<void>((resolve) => {
      releaseCallbacks = resolve;
    });
    const barrierStore: WagerTransactionProcessingStore = {
      executeIdempotently: (identity, createArtifacts) =>
        delegate.executeIdempotently(identity, async (context) => {
          callbackCount += 1;
          if (callbackCount === 2) releaseCallbacks?.();
          await callbacksReady;
          return createArtifacts(context);
        }),
    };
    const useCase = new ProcessWagerTransaction(barrierStore);
    const identity = `cross-wallet-${randomUUID()}`;
    const results = await Promise.allSettled([
      useCase.execute(
        processInput(first.wallet, WagerTransactionKind.BET, "10.00", identity),
      ),
      useCase.execute(
        processInput(
          second.wallet,
          WagerTransactionKind.BET,
          "10.00",
          identity,
        ),
      ),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected?.status).toBe("rejected");
    if (rejected?.status === "rejected") {
      expect(rejected.reason).toBeInstanceOf(IdempotencyConflictError);
    }
    const balances = await Promise.all([
      readWallet(first.wallet.id),
      readWallet(second.wallet.id),
    ]);
    expect(balances.map((row) => row?.balance).sort()).toEqual([
      "40.00",
      "50.00",
    ]);
    expect(callbackCount).toBe(2);
  });

  test("uses the provider identity constraint to stop a cross-wallet concurrent duplicate", async () => {
    const [first, second] = await Promise.all([
      createFundedWallet("50.00"),
      createFundedWallet("50.00"),
    ]);
    const delegate = new MikroOrmWagerTransactionProcessingStore(orm);
    let callbackCount = 0;
    let releaseCallbacks: (() => void) | undefined;
    const callbacksReady = new Promise<void>((resolve) => {
      releaseCallbacks = resolve;
    });
    const barrierStore: WagerTransactionProcessingStore = {
      executeIdempotently: (identity, createArtifacts) =>
        delegate.executeIdempotently(identity, async (context) => {
          callbackCount += 1;
          if (callbackCount === 2) releaseCallbacks?.();
          await callbacksReady;
          return createArtifacts(context);
        }),
    };
    const useCase = new ProcessWagerTransaction(barrierStore);
    const externalTransactionId = `shared-external-${randomUUID()}`;
    const base = {
      providerId: "integration-provider",
      externalTransactionId,
      roundId: "integration-round",
      gameId: "integration-game",
      kind: WagerTransactionKind.BET,
      money: { amount: "10.00", currency: "BRL" },
    };
    const results = await Promise.allSettled([
      useCase.execute({
        ...base,
        idempotencyKey: `provider-race-a-${randomUUID()}`,
        playerId: first.playerId,
        walletId: first.wallet.id,
      }),
      useCase.execute({
        ...base,
        idempotencyKey: `provider-race-b-${randomUUID()}`,
        playerId: second.playerId,
        walletId: second.wallet.id,
      }),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected?.status).toBe("rejected");
    if (rejected?.status === "rejected") {
      expect(rejected.reason).toBeInstanceOf(ProviderTransactionConflictError);
    }
    const balances = await Promise.all([
      readWallet(first.wallet.id),
      readWallet(second.wallet.id),
    ]);
    expect(balances.map((row) => row?.balance).sort()).toEqual([
      "40.00",
      "50.00",
    ]);
    expect(callbackCount).toBe(2);
  });

  test("allows only one of two concurrent BETs to spend the same remaining balance", async () => {
    const { playerId, wallet } = await createFundedWallet("100.00");
    const useCase = processor();
    const results = await Promise.all([
      useCase.execute(
        processInput(wallet, WagerTransactionKind.BET, "80.00", "race-a"),
      ),
      useCase.execute(
        processInput(wallet, WagerTransactionKind.BET, "80.00", "race-b"),
      ),
    ]);
    expect(
      results.filter(
        (result) => result.status === WagerTransactionStatus.PROCESSED,
      ),
    ).toHaveLength(1);
    expect(
      results.filter(
        (result) =>
          result.failureCode ===
          WagerTransactionRejectionCode.INSUFFICIENT_FUNDS,
      ),
    ).toHaveLength(1);
    expect(await readWallet(wallet.id)).toEqual({
      balance: "20.00",
      version: "2",
    });
    expect(await countsForPlayer(playerId)).toEqual({
      wallets: 1,
      transactions: 3,
      ledger: 2,
      outbox: 5,
    });
    expect(await reconstructedBalance(playerId)).toEqual({
      amount: "20.00",
      currency: "BRL",
    });
  });

  test("processes different wallets independently with per-wallet row locks", async () => {
    const [first, second] = await Promise.all([
      createFundedWallet("50.00"),
      createFundedWallet("50.00"),
    ]);
    const useCase = processor();
    const results = await Promise.all([
      useCase.execute(
        processInput(first.wallet, WagerTransactionKind.BET, "10.00"),
      ),
      useCase.execute(
        processInput(second.wallet, WagerTransactionKind.BET, "10.00"),
      ),
    ]);
    expect(results.every((result) => !result.idempotentReplay)).toBe(true);
    expect(await readWallet(first.wallet.id)).toEqual({
      balance: "40.00",
      version: "2",
    });
    expect(await readWallet(second.wallet.id)).toEqual({
      balance: "40.00",
      version: "2",
    });
    expect(await reconstructedBalance(first.playerId)).toEqual({
      amount: "40.00",
      currency: "BRL",
    });
    expect(await reconstructedBalance(second.playerId)).toEqual({
      amount: "40.00",
      currency: "BRL",
    });
  });

  test("rolls back wallet, transaction, ledger and outbox when outbox persistence fails", async () => {
    const { playerId, wallet } = await createFundedWallet("100.00");
    const beforeCounts = await countsForPlayer(playerId);
    await connection().execute(`
      create function reject_processed_outbox() returns trigger language plpgsql as $$
      begin
        if new.event_type = 'wager.transaction.processed.v1' then
          raise exception 'forced outbox failure';
        end if;
        return new;
      end;
      $$
    `);
    await connection().execute(`
      create trigger reject_processed_outbox_trigger
      before insert on outbox_messages
      for each row execute function reject_processed_outbox()
    `);
    try {
      await expect(
        processor().execute(
          processInput(wallet, WagerTransactionKind.BET, "20.00"),
        ),
      ).rejects.toThrow("forced outbox failure");
    } finally {
      await connection().execute(
        "drop trigger reject_processed_outbox_trigger on outbox_messages",
      );
      await connection().execute("drop function reject_processed_outbox()");
    }
    expect(await readWallet(wallet.id)).toEqual({
      balance: "100.00",
      version: "1",
    });
    expect(await countsForPlayer(playerId)).toEqual(beforeCounts);
    expect(await reconstructedBalance(playerId)).toEqual({
      amount: "100.00",
      currency: "BRL",
    });
  });

  test("rejects missing wallets and wallet player or currency mismatches", async () => {
    const { wallet } = await createFundedWallet("10.00");
    const useCase = processor();
    await expect(
      useCase.execute({
        ...processInput(wallet, WagerTransactionKind.BET, "1.00"),
        walletId: "missing-wallet",
      }),
    ).rejects.toThrow("Wallet missing-wallet was not found");
    await expect(
      useCase.execute({
        ...processInput(wallet, WagerTransactionKind.BET, "1.00"),
        playerId: "another-player",
      }),
    ).rejects.toThrow("Wallet does not belong to the requested player");
    await expect(
      useCase.execute({
        ...processInput(wallet, WagerTransactionKind.BET, "1.00"),
        money: { amount: "1.00", currency: "USD" },
      }),
    ).rejects.toThrow("Wallet currency does not match transaction currency");
  });

  test("processes REFUND and each supported ROLLBACK inverse exactly", async () => {
    const { playerId, wallet } = await createFundedWallet("100.00");
    const useCase = processor();
    const betIdentity = `refund-base-${randomUUID()}`;
    const bet = await useCase.execute(
      processInput(wallet, WagerTransactionKind.BET, "20.00", betIdentity),
    );
    const refund = await useCase.execute(
      processInput(
        wallet,
        WagerTransactionKind.REFUND,
        "20.00",
        `refund-${randomUUID()}`,
        `external-${betIdentity}`,
      ),
    );
    expect(refund.status).toBe(WagerTransactionStatus.PROCESSED);
    expect(refund.resultingBalance).toEqual({
      amount: "100.00",
      currency: "BRL",
    });
    const refundRecord = await transactionById(refund.transactionId);
    expect(refundRecord.referenceTransactionId).toBe(bet.transactionId);

    const betRollback = await useCase.execute(
      processInput(
        wallet,
        WagerTransactionKind.ROLLBACK,
        "20.00",
        `rollback-bet-${randomUUID()}`,
        `external-${betIdentity}`,
      ),
    );
    expect(betRollback.resultingBalance).toEqual({
      amount: "120.00",
      currency: "BRL",
    });

    const winIdentity = `rollback-win-base-${randomUUID()}`;
    const win = await useCase.execute(
      processInput(wallet, WagerTransactionKind.WIN, "10.00", winIdentity),
    );
    const winRollback = await useCase.execute(
      processInput(
        wallet,
        WagerTransactionKind.ROLLBACK,
        "10.00",
        `rollback-win-${randomUUID()}`,
        `external-${winIdentity}`,
      ),
    );
    expect(winRollback.resultingBalance).toEqual({
      amount: "120.00",
      currency: "BRL",
    });

    const refundBaseIdentity = `rollback-refund-base-${randomUUID()}`;
    const refundBaseBet = await useCase.execute(
      processInput(
        wallet,
        WagerTransactionKind.BET,
        "5.00",
        refundBaseIdentity,
      ),
    );
    const secondRefund = await useCase.execute(
      processInput(
        wallet,
        WagerTransactionKind.REFUND,
        "5.00",
        `refund-base-${randomUUID()}`,
        `external-${refundBaseIdentity}`,
      ),
    );
    const secondRefundRecord = await transactionById(
      secondRefund.transactionId,
    );
    if (secondRefundRecord.externalTransactionId === null) {
      throw new Error("Processed refund must have an external transaction id");
    }
    const refundRollback = await useCase.execute(
      processInput(
        wallet,
        WagerTransactionKind.ROLLBACK,
        "5.00",
        `rollback-refund-${randomUUID()}`,
        secondRefundRecord.externalTransactionId,
      ),
    );
    expect(refundRollback.resultingBalance).toEqual({
      amount: "115.00",
      currency: "BRL",
    });
    expect(
      (await transactionById(betRollback.transactionId)).referenceTransactionId,
    ).toBe(bet.transactionId);
    expect(
      (await transactionById(winRollback.transactionId)).referenceTransactionId,
    ).toBe(win.transactionId);
    expect(
      (await transactionById(refundRollback.transactionId))
        .referenceTransactionId,
    ).toBe(secondRefund.transactionId);
    expect((await transactionById(refundBaseBet.transactionId)).status).toBe(
      WagerTransactionStatus.PROCESSED,
    );
    expect(await readWallet(wallet.id)).toEqual({
      balance: "115.00",
      version: "9",
    });
    expect(await reconstructedBalance(playerId)).toEqual({
      amount: "115.00",
      currency: "BRL",
    });
  });

  test("rejects reference mismatches, unsupported kinds and reversal amount mismatches", async () => {
    const { playerId, wallet } = await createFundedWallet("100.00");
    const useCase = processor();
    const sourceIdentity = `reference-source-${randomUUID()}`;
    await useCase.execute(
      processInput(wallet, WagerTransactionKind.BET, "20.00", sourceIdentity),
    );

    const mismatch = async (
      kind: WagerTransactionKind,
      reference: string,
      amount: string,
      identity: string,
      roundId = "integration-round",
      targetWallet = wallet,
    ) =>
      useCase.execute({
        ...processInput(targetWallet, kind, amount, identity, reference),
        roundId,
      });

    const amountMismatch = await mismatch(
      WagerTransactionKind.REFUND,
      `external-${sourceIdentity}`,
      "19.00",
      `bad-refund-${randomUUID()}`,
    );
    expect(amountMismatch.failureCode).toBe(
      WagerTransactionRejectionCode.REFERENCE_AMOUNT_MISMATCH,
    );
    const rollbackAmountMismatch = await mismatch(
      WagerTransactionKind.ROLLBACK,
      `external-${sourceIdentity}`,
      "19.00",
      `bad-rollback-${randomUUID()}`,
    );
    expect(rollbackAmountMismatch.failureCode).toBe(
      WagerTransactionRejectionCode.REFERENCE_AMOUNT_MISMATCH,
    );
    const roundMismatch = await mismatch(
      WagerTransactionKind.REFUND,
      `external-${sourceIdentity}`,
      "20.00",
      `bad-round-${randomUUID()}`,
      "another-round",
    );
    expect(roundMismatch.failureCode).toBe(
      WagerTransactionRejectionCode.REFERENCE_ROUND_MISMATCH,
    );

    const lossIdentity = `reference-loss-${randomUUID()}`;
    await useCase.execute(
      processInput(wallet, WagerTransactionKind.LOSS, "20.00", lossIdentity),
    );
    const invalidKind = await mismatch(
      WagerTransactionKind.REFUND,
      `external-${lossIdentity}`,
      "20.00",
      `invalid-kind-${randomUUID()}`,
    );
    expect(invalidKind.failureCode).toBe(
      WagerTransactionRejectionCode.INVALID_REFERENCE_KIND,
    );

    const { wallet: otherPlayerWallet } = await createFundedWallet("100.00");
    const otherPlayerIdentity = `other-player-ref-${randomUUID()}`;
    await useCase.execute(
      processInput(
        otherPlayerWallet,
        WagerTransactionKind.BET,
        "20.00",
        otherPlayerIdentity,
      ),
    );
    const playerMismatch = await mismatch(
      WagerTransactionKind.REFUND,
      `external-${otherPlayerIdentity}`,
      "20.00",
      `bad-player-${randomUUID()}`,
    );
    expect(playerMismatch.failureCode).toBe(
      WagerTransactionRejectionCode.REFERENCE_PLAYER_MISMATCH,
    );

    const sharedPlayer = `shared-reference-player-${randomUUID()}`;
    const { wallet: brlWallet } = await createFundedWallet(
      "20.00",
      "BRL",
      sharedPlayer,
    );
    const { wallet: usdWallet } = await createFundedWallet(
      "20.00",
      "USD",
      sharedPlayer,
    );
    const usdIdentity = `usd-reference-${randomUUID()}`;
    await useCase.execute(
      processInput(usdWallet, WagerTransactionKind.BET, "5.00", usdIdentity),
    );
    const walletMismatch = await mismatch(
      WagerTransactionKind.REFUND,
      `external-${usdIdentity}`,
      "5.00",
      `bad-wallet-${randomUUID()}`,
      "integration-round",
      brlWallet,
    );
    expect(walletMismatch.failureCode).toBe(
      WagerTransactionRejectionCode.REFERENCE_WALLET_MISMATCH,
    );
    expect((await countsForPlayer(playerId)).wallets).toBe(1);
  });

  test("serializes twenty concurrent REFUNDs and permits exactly one", async () => {
    const { playerId, wallet } = await createFundedWallet("100.00");
    const useCase = processor();
    const betIdentity = `refund-race-bet-${randomUUID()}`;
    await useCase.execute(
      processInput(wallet, WagerTransactionKind.BET, "20.00", betIdentity),
    );
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        processInput(
          wallet,
          WagerTransactionKind.REFUND,
          "20.00",
          `refund-race-${index}-${randomUUID()}`,
          `external-${betIdentity}`,
        ),
      ).map((input) => useCase.execute(input)),
    );
    expect(
      results.filter(
        (result) => result.status === WagerTransactionStatus.PROCESSED,
      ),
    ).toHaveLength(1);
    expect(
      results.filter(
        (result) =>
          result.failureCode === WagerTransactionRejectionCode.ALREADY_REFUNDED,
      ),
    ).toHaveLength(19);
    expect(await readWallet(wallet.id)).toEqual({
      balance: "100.00",
      version: "3",
    });
    expect(await countsForPlayer(playerId)).toEqual({
      wallets: 1,
      transactions: 22,
      ledger: 3,
      outbox: 25,
    });
    const processedRefund = results.find(
      (result) => result.status === WagerTransactionStatus.PROCESSED,
    );
    if (processedRefund === undefined) {
      throw new Error(
        "The concurrent refund set must contain one processed result",
      );
    }
    const processedRefundRecord = await transactionById(
      processedRefund.transactionId,
    );
    await expect(
      connection().execute(
        `insert into wager_transactions (
          id, provider_id, external_transaction_id, idempotency_key, payload_hash,
          wallet_id, player_id, round_id, game_id, kind, status, amount,
          resulting_balance, currency, reference_external_transaction_id,
          reference_transaction_id, processed_at, created_at, updated_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, 'REFUND', 'PROCESSED', ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          randomUUID(),
          processedRefundRecord.providerId,
          `manual-duplicate-${randomUUID()}`,
          `manual-duplicate-key-${randomUUID()}`,
          "manual-duplicate-hash",
          wallet.id,
          playerId,
          "integration-round",
          "integration-game",
          "20.00",
          "100.00",
          "BRL",
          processedRefundRecord.referenceExternalTransactionId,
          processedRefundRecord.referenceTransactionId,
          instant,
          instant,
          instant,
        ],
      ),
    ).rejects.toThrow("wager_transactions_processed_reversal_unique");
    expect(await reconstructedBalance(playerId)).toEqual({
      amount: "100.00",
      currency: "BRL",
    });
  });

  test("serializes twenty concurrent ROLLBACKs and permits exactly one", async () => {
    const { playerId, wallet } = await createFundedWallet("100.00");
    const useCase = processor();
    const betIdentity = `rollback-race-bet-${randomUUID()}`;
    await useCase.execute(
      processInput(wallet, WagerTransactionKind.BET, "20.00", betIdentity),
    );
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        processInput(
          wallet,
          WagerTransactionKind.ROLLBACK,
          "20.00",
          `rollback-race-${index}-${randomUUID()}`,
          `external-${betIdentity}`,
        ),
      ).map((input) => useCase.execute(input)),
    );
    expect(
      results.filter(
        (result) => result.status === WagerTransactionStatus.PROCESSED,
      ),
    ).toHaveLength(1);
    expect(
      results.filter(
        (result) =>
          result.failureCode ===
          WagerTransactionRejectionCode.ALREADY_ROLLED_BACK,
      ),
    ).toHaveLength(19);
    expect(await readWallet(wallet.id)).toEqual({
      balance: "100.00",
      version: "3",
    });
    expect(await countsForPlayer(playerId)).toEqual({
      wallets: 1,
      transactions: 22,
      ledger: 3,
      outbox: 25,
    });
    expect(await reconstructedBalance(playerId)).toEqual({
      amount: "100.00",
      currency: "BRL",
    });
  });

  test("validates a shared reversal reference across concurrently locked wallets", async () => {
    const sharedPlayerId = `cross-wallet-reversal-${randomUUID()}`;
    const { wallet: brlWallet } = await createFundedWallet(
      "100.00",
      "BRL",
      sharedPlayerId,
    );
    const { wallet: usdWallet } = await createFundedWallet(
      "50.00",
      "USD",
      sharedPlayerId,
    );
    const betIdentity = `cross-wallet-reversal-bet-${randomUUID()}`;
    await processor().execute(
      processInput(brlWallet, WagerTransactionKind.BET, "20.00", betIdentity),
    );
    const delegate = new MikroOrmWagerTransactionProcessingStore(orm);
    let callbackCount = 0;
    let releaseCallbacks: (() => void) | undefined;
    const callbacksReady = new Promise<void>((resolve) => {
      releaseCallbacks = resolve;
    });
    const barrierStore: WagerTransactionProcessingStore = {
      executeIdempotently: (identity, createArtifacts) =>
        delegate.executeIdempotently(identity, async (context) => {
          callbackCount += 1;
          if (callbackCount === 2) releaseCallbacks?.();
          await callbacksReady;
          return createArtifacts(context);
        }),
    };
    const useCase = new ProcessWagerTransaction(barrierStore);
    const results = await Promise.all([
      useCase.execute(
        processInput(
          brlWallet,
          WagerTransactionKind.REFUND,
          "20.00",
          `valid-cross-wallet-refund-${randomUUID()}`,
          `external-${betIdentity}`,
        ),
      ),
      useCase.execute(
        processInput(
          usdWallet,
          WagerTransactionKind.REFUND,
          "20.00",
          `invalid-cross-wallet-refund-${randomUUID()}`,
          `external-${betIdentity}`,
        ),
      ),
    ]);
    expect(
      results.filter(
        (result) => result.status === WagerTransactionStatus.PROCESSED,
      ),
    ).toHaveLength(1);
    expect(
      results.filter(
        (result) =>
          result.failureCode ===
          WagerTransactionRejectionCode.REFERENCE_WALLET_MISMATCH,
      ),
    ).toHaveLength(1);
    expect(await readWallet(brlWallet.id)).toEqual({
      balance: "100.00",
      version: "3",
    });
    expect(await readWallet(usdWallet.id)).toEqual({
      balance: "50.00",
      version: "1",
    });
    expect(await reconstructedWalletBalance(brlWallet.id)).toEqual({
      amount: "100.00",
      currency: "BRL",
    });
    expect(await reconstructedWalletBalance(usdWallet.id)).toEqual({
      amount: "50.00",
      currency: "USD",
    });
  });

  test("rejects a reversal that would make the wallet negative", async () => {
    const { playerId, wallet } = await createFundedWallet("100.00");
    const useCase = processor();
    const winIdentity = `negative-reversal-win-${randomUUID()}`;
    await useCase.execute(
      processInput(wallet, WagerTransactionKind.WIN, "50.00", winIdentity),
    );
    await useCase.execute(
      processInput(wallet, WagerTransactionKind.BET, "140.00"),
    );
    const countsBeforeRollback = await countsForPlayer(playerId);
    const rollback = await useCase.execute(
      processInput(
        wallet,
        WagerTransactionKind.ROLLBACK,
        "50.00",
        `negative-rollback-${randomUUID()}`,
        `external-${winIdentity}`,
      ),
    );
    expect(rollback.status).toBe(WagerTransactionStatus.REJECTED);
    expect(rollback.failureCode).toBe(
      WagerTransactionRejectionCode.REVERSAL_WOULD_CAUSE_NEGATIVE_BALANCE,
    );
    expect(rollback.resultingBalance).toBeNull();
    expect(await readWallet(wallet.id)).toEqual({
      balance: "10.00",
      version: "3",
    });
    const countsAfterRollback = await countsForPlayer(playerId);
    expect(countsAfterRollback.ledger).toBe(countsBeforeRollback.ledger);
    expect(countsAfterRollback.outbox).toBe(countsBeforeRollback.outbox + 1);
    expect(await outboxCountForTransaction(rollback.transactionId)).toBe(1);
    expect(await reconstructedBalance(playerId)).toEqual({
      amount: "10.00",
      currency: "BRL",
    });
  });

  test("stores out-of-order REFUND and WIN references without applying their effects", async () => {
    const { playerId, wallet } = await createFundedWallet("100.00");
    const useCase = processor();
    const pendingRefundInput = processInput(
      wallet,
      WagerTransactionKind.REFUND,
      "20.00",
      `pending-refund-${randomUUID()}`,
      "external-future-reference-bet",
    );
    const pendingRefund = await useCase.execute(pendingRefundInput);
    const pendingRefundReplay = await useCase.execute(pendingRefundInput);
    const pendingWinInput = processInput(
      wallet,
      WagerTransactionKind.WIN,
      "7.00",
      `pending-win-${randomUUID()}`,
      "external-future-win-bet",
    );
    const pendingWin = await useCase.execute(pendingWinInput);
    const pendingWinReplay = await useCase.execute(pendingWinInput);
    expect(pendingRefund.status).toBe(WagerTransactionStatus.PENDING_REFERENCE);
    expect(pendingWin.status).toBe(WagerTransactionStatus.PENDING_REFERENCE);
    expect(pendingRefund.resultingBalance).toBeNull();
    expect(pendingWin.resultingBalance).toBeNull();
    expect(pendingRefundReplay.idempotentReplay).toBe(true);
    expect(pendingRefundReplay.transactionId).toBe(pendingRefund.transactionId);
    expect(pendingWinReplay.idempotentReplay).toBe(true);
    expect(pendingWinReplay.transactionId).toBe(pendingWin.transactionId);
    expect(await outboxCountForTransaction(pendingRefund.transactionId)).toBe(
      1,
    );
    expect(await outboxCountForTransaction(pendingWin.transactionId)).toBe(1);
    expect(await readWallet(wallet.id)).toEqual({
      balance: "100.00",
      version: "1",
    });

    const referenceBet = await useCase.execute({
      ...processInput(
        wallet,
        WagerTransactionKind.BET,
        "20.00",
        "future-reference-bet",
      ),
      externalTransactionId: "external-future-reference-bet",
    });
    await useCase.execute({
      ...processInput(
        wallet,
        WagerTransactionKind.BET,
        "5.00",
        "future-win-bet",
      ),
      externalTransactionId: "external-future-win-bet",
    });
    expect((await transactionById(pendingRefund.transactionId)).status).toBe(
      WagerTransactionStatus.PENDING_REFERENCE,
    );
    expect((await transactionById(pendingWin.transactionId)).status).toBe(
      WagerTransactionStatus.PENDING_REFERENCE,
    );
    expect(
      (await transactionById(pendingRefund.transactionId))
        .referenceTransactionId,
    ).toBeNull();
    expect(referenceBet.status).toBe(WagerTransactionStatus.PROCESSED);
    expect(await readWallet(wallet.id)).toEqual({
      balance: "75.00",
      version: "3",
    });
    expect(await reconstructedBalance(playerId)).toEqual({
      amount: "75.00",
      currency: "BRL",
    });
  });

  test("recovers the same pending REFUND after its BET appears", async () => {
    const { playerId, wallet } = await createFundedWallet("100.00");
    const useCase = processor();
    const refund = await useCase.execute(
      processInput(
        wallet,
        WagerTransactionKind.REFUND,
        "20.00",
        `retry-refund-${randomUUID()}`,
        "external-retry-bet",
      ),
    );
    expect(
      (await retryState(refund.transactionId))?.reference_retry_attempts,
    ).toBe(0);
    await deferOtherPendingReferences([refund.transactionId]);
    const recovery = referenceRecovery();
    const firstAttempt = new Date(Date.now() + 10_000);
    await recovery.runBatch(firstAttempt);
    const afterMiss = await retryState(refund.transactionId);
    if (afterMiss === undefined) {
      throw new Error(
        "Retry state was not persisted after a missing reference",
      );
    }
    expect(afterMiss?.reference_retry_attempts).toBe(1);
    expect(afterMiss?.reference_next_attempt_at?.getTime()).toBe(
      firstAttempt.getTime() + 2_000,
    );

    const bet = await useCase.execute({
      ...processInput(wallet, WagerTransactionKind.BET, "20.00"),
      externalTransactionId: "external-retry-bet",
    });
    await recovery.runBatch(await retryDueAt(refund.transactionId));
    const recovered = await transactionById(refund.transactionId);
    expect(recovered.id).toBe(refund.transactionId);
    expect(recovered.referenceTransactionId).toBe(bet.transactionId);
    expect(recovered.status).toBe(WagerTransactionStatus.PROCESSED);
    expect(recovered.resultingBalance).toBe("100.00");
    expect(await readWallet(wallet.id)).toEqual({
      balance: "100.00",
      version: "3",
    });
    expect(await outboxCountForTransaction(refund.transactionId)).toBe(3);
    expect(await reconstructedBalance(playerId)).toEqual({
      amount: "100.00",
      currency: "BRL",
    });
  });

  test("recovers pending WIN and ROLLBACK with their original transaction identities", async () => {
    const { wallet } = await createFundedWallet("100.00");
    const useCase = processor();
    const recovery = referenceRecovery();
    const win = await useCase.execute(
      processInput(
        wallet,
        WagerTransactionKind.WIN,
        "25.00",
        `retry-win-${randomUUID()}`,
        "external-retry-win-bet",
      ),
    );
    await deferOtherPendingReferences([win.transactionId]);
    await recovery.runBatch(new Date(Date.now() + 10_000));
    await useCase.execute({
      ...processInput(wallet, WagerTransactionKind.BET, "10.00"),
      externalTransactionId: "external-retry-win-bet",
    });
    await recovery.runBatch(await retryDueAt(win.transactionId));
    expect((await transactionById(win.transactionId)).status).toBe(
      WagerTransactionStatus.PROCESSED,
    );
    expect((await transactionById(win.transactionId)).resultingBalance).toBe(
      "115.00",
    );

    const rollbackWalletState = await createFundedWallet("100.00");
    const rollbackWallet = rollbackWalletState.wallet;
    const rollback = await useCase.execute(
      processInput(
        rollbackWallet,
        WagerTransactionKind.ROLLBACK,
        "5.00",
        `retry-rollback-${randomUUID()}`,
        "external-retry-rollback-win",
      ),
    );
    await deferOtherPendingReferences([rollback.transactionId]);
    await recovery.runBatch(new Date(Date.now() + 20_000));
    await useCase.execute({
      ...processInput(rollbackWallet, WagerTransactionKind.WIN, "5.00"),
      externalTransactionId: "external-retry-rollback-win",
    });
    await recovery.runBatch(await retryDueAt(rollback.transactionId));
    expect((await transactionById(rollback.transactionId)).id).toBe(
      rollback.transactionId,
    );
    expect((await transactionById(rollback.transactionId)).status).toBe(
      WagerTransactionStatus.PROCESSED,
    );
    expect(await readWallet(rollbackWallet.id)).toEqual({
      balance: "100.00",
      version: "3",
    });
    expect(await reconstructedBalance(rollbackWalletState.playerId)).toEqual({
      amount: "100.00",
      currency: "BRL",
    });
  });

  test("rejects a pending WIN when its later BET reference is terminally rejected", async () => {
    const { wallet } = await createFundedWallet("0.00");
    const useCase = processor();
    const recovery = referenceRecovery();
    const win = await useCase.execute(
      processInput(
        wallet,
        WagerTransactionKind.WIN,
        "25.00",
        `retry-invalid-win-${randomUUID()}`,
        "external-retry-rejected-bet",
      ),
    );
    await deferOtherPendingReferences([win.transactionId]);
    await recovery.runBatch(new Date(Date.now() + 10_000));
    await useCase.execute({
      ...processInput(wallet, WagerTransactionKind.BET, "10.00"),
      externalTransactionId: "external-retry-rejected-bet",
    });
    await recovery.runBatch(await retryDueAt(win.transactionId));
    const rejected = await transactionById(win.transactionId);
    expect(rejected.status).toBe(WagerTransactionStatus.REJECTED);
    expect(rejected.failureCode).toBe(
      WagerTransactionRejectionCode.REFERENCE_NOT_PROCESSED,
    );
    expect(await readWallet(wallet.id)).toEqual({
      balance: "0.00",
      version: "1",
    });
    expect(await outboxCountForTransaction(win.transactionId)).toBe(2);
  });

  test("exhausts missing-reference attempts without rescheduling", async () => {
    const { playerId, wallet } = await createFundedWallet("30.00");
    const refund = await processor().execute(
      processInput(
        wallet,
        WagerTransactionKind.REFUND,
        "5.00",
        `exhaust-${randomUUID()}`,
        "never-arrives",
      ),
    );
    await deferOtherPendingReferences([refund.transactionId]);
    const recovery = referenceRecovery({ maxAttempts: 2 });
    await recovery.runBatch(new Date(Date.now() + 10_000));
    const firstRetry = await retryState(refund.transactionId);
    expect(firstRetry?.reference_retry_attempts).toBe(1);
    await recovery.runBatch(await retryDueAt(refund.transactionId));
    const exhausted = await transactionById(refund.transactionId);
    expect(exhausted.status).toBe(WagerTransactionStatus.REJECTED);
    expect(exhausted.failureCode).toBe(
      WagerTransactionRejectionCode.REFERENCE_NOT_FOUND,
    );
    expect(
      (await retryState(refund.transactionId))?.reference_next_attempt_at,
    ).toBeNull();
    expect(await outboxCountForTransaction(refund.transactionId)).toBe(2);
    expect(await readWallet(wallet.id)).toEqual({
      balance: "30.00",
      version: "1",
    });
    expect(await reconstructedBalance(playerId)).toEqual({
      amount: "30.00",
      currency: "BRL",
    });
  });

  test("skips a locked pending transaction so another worker can claim different work", async () => {
    const { wallet: firstWallet } = await createFundedWallet("100.00");
    const { wallet: secondWallet } = await createFundedWallet("100.00");
    const useCase = processor();
    const pending = await Promise.all([
      useCase.execute(
        processInput(
          firstWallet,
          WagerTransactionKind.REFUND,
          "1.00",
          `claim-a-${randomUUID()}`,
          "claim-missing-a",
        ),
      ),
      useCase.execute(
        processInput(
          secondWallet,
          WagerTransactionKind.REFUND,
          "1.00",
          `claim-b-${randomUUID()}`,
          "claim-missing-b",
        ),
      ),
    ]);
    const firstPending = pending[0];
    const secondPending = pending[1];
    if (firstPending === undefined || secondPending === undefined) {
      throw new Error("Expected two pending transactions");
    }
    await deferOtherPendingReferences(
      pending.map((item) => item.transactionId),
    );
    const now = new Date(Date.now() + 10_000);
    let signalClaimed = () => {};
    let releaseClaim = () => {};
    const claimed = new Promise<void>((resolve) => {
      signalClaimed = resolve;
    });
    const released = new Promise<void>((resolve) => {
      releaseClaim = resolve;
    });
    const firstStore = new MikroOrmWagerTransactionProcessingStore(orm);
    const firstWorker = firstStore.recoverDue(
      { now, baseDelayMs: 1000, maxAttempts: 8, batchSize: 1 },
      async () => {
        signalClaimed();
        await released;
        return null;
      },
    );
    await claimed;
    const secondWorker = referenceRecovery({ batchSize: 1 });
    expect(await secondWorker.runBatch(now)).toBe(1);
    releaseClaim();
    expect(await firstWorker).toBe(1);
    expect(
      (await retryState(firstPending.transactionId))?.reference_retry_attempts,
    ).toBe(1);
    expect(
      (await retryState(secondPending.transactionId))?.reference_retry_attempts,
    ).toBe(1);
  });

  test("rolls back a failed recovery and then processes it once on retry", async () => {
    const { playerId, wallet } = await createFundedWallet("50.00");
    const useCase = processor();
    const pending = await useCase.execute(
      processInput(
        wallet,
        WagerTransactionKind.REFUND,
        "10.00",
        `crash-recovery-${randomUUID()}`,
        "external-crash-reference",
      ),
    );
    const recovery = referenceRecovery();
    await deferOtherPendingReferences([pending.transactionId]);
    await recovery.runBatch(new Date(Date.now() + 10_000));
    const due = await retryDueAt(pending.transactionId);
    await useCase.execute({
      ...processInput(wallet, WagerTransactionKind.BET, "10.00"),
      externalTransactionId: "external-crash-reference",
    });
    const before = await countsForPlayer(playerId);
    await connection().execute(
      `create function reject_recovery_outbox() returns trigger language plpgsql as $$ begin if new.event_type = 'wager.transaction.processed.v1' then raise exception 'forced recovery outbox failure'; end if; return new; end; $$`,
    );
    await connection().execute(
      "create trigger reject_recovery_outbox_trigger before insert on outbox_messages for each row execute function reject_recovery_outbox()",
    );
    try {
      await expect(recovery.runBatch(due)).rejects.toThrow(
        "forced recovery outbox failure",
      );
    } finally {
      await connection().execute(
        "drop trigger reject_recovery_outbox_trigger on outbox_messages",
      );
      await connection().execute("drop function reject_recovery_outbox()");
    }
    expect((await transactionById(pending.transactionId)).status).toBe(
      WagerTransactionStatus.PENDING_REFERENCE,
    );
    expect(
      (await retryState(pending.transactionId))?.reference_retry_attempts,
    ).toBe(1);
    expect(await readWallet(wallet.id)).toEqual({
      balance: "40.00",
      version: "2",
    });
    expect(await countsForPlayer(playerId)).toEqual(before);
    await recovery.runBatch(due);
    expect((await transactionById(pending.transactionId)).status).toBe(
      WagerTransactionStatus.PROCESSED,
    );
    expect(await readWallet(wallet.id)).toEqual({
      balance: "50.00",
      version: "3",
    });
    expect(await reconstructedBalance(playerId)).toEqual({
      amount: "50.00",
      currency: "BRL",
    });
  });

  test("requires a referenced WIN BET to be processed before crediting", async () => {
    const { playerId, wallet } = await createFundedWallet("0.00");
    const useCase = processor();

    const rejectedBetIdentity = `rejected-reference-${randomUUID()}`;
    const rejectedBet = await useCase.execute(
      processInput(
        wallet,
        WagerTransactionKind.BET,
        "10.00",
        rejectedBetIdentity,
      ),
    );
    expect(rejectedBet.status).toBe(WagerTransactionStatus.REJECTED);

    const countsBeforeWin = await countsForPlayer(playerId);
    const rejectedWin = await useCase.execute(
      processInput(
        wallet,
        WagerTransactionKind.WIN,
        "25.00",
        `win-against-rejected-${randomUUID()}`,
        `external-${rejectedBetIdentity}`,
      ),
    );
    expect(rejectedWin.status).toBe(WagerTransactionStatus.REJECTED);
    expect(rejectedWin.failureCode).toBe(
      WagerTransactionRejectionCode.REFERENCE_NOT_PROCESSED,
    );
    expect(await readWallet(wallet.id)).toEqual({
      balance: "0.00",
      version: "1",
    });
    const countsAfterWin = await countsForPlayer(playerId);
    expect(countsAfterWin.ledger).toBe(countsBeforeWin.ledger);
    expect(countsAfterWin.outbox).toBe(countsBeforeWin.outbox + 1);
    expect(await outboxCountForTransaction(rejectedWin.transactionId)).toBe(1);
    expect(
      await connection().execute(
        "select count(*)::integer as count from outbox_messages where payload->>'transactionId' = ? and event_type = 'wallet.balance.changed.v1'",
        [rejectedWin.transactionId],
      ),
    ).toEqual([{ count: 0 }]);

    const pendingExternalId = `pending-bet-${randomUUID()}`;
    await createTransaction(
      `pending-bet-${randomUUID()}`,
      wallet.id,
      `pending-key-${randomUUID()}`,
      pendingExternalId,
      wallet.playerId,
      wallet.currency,
    );
    const pendingWin = await useCase.execute(
      processInput(
        wallet,
        WagerTransactionKind.WIN,
        "25.00",
        `win-against-pending-${randomUUID()}`,
        pendingExternalId,
      ),
    );
    expect(pendingWin.status).toBe(WagerTransactionStatus.PENDING_REFERENCE);
    expect(pendingWin.resultingBalance).toBeNull();
    expect(await outboxCountForTransaction(pendingWin.transactionId)).toBe(1);
    expect(await reconstructedBalance(playerId)).toEqual({
      amount: "0.00",
      currency: "BRL",
    });
  });

  test("rolls back a prepared REFUND if outbox persistence fails", async () => {
    const { playerId, wallet } = await createFundedWallet("100.00");
    const useCase = processor();
    const betIdentity = `refund-rollback-bet-${randomUUID()}`;
    await useCase.execute(
      processInput(wallet, WagerTransactionKind.BET, "20.00", betIdentity),
    );
    const beforeCounts = await countsForPlayer(playerId);
    await connection().execute(`
      create function reject_refund_outbox() returns trigger language plpgsql as $$
      begin
        if new.event_type = 'wager.transaction.processed.v1' then
          raise exception 'forced reversal outbox failure';
        end if;
        return new;
      end;
      $$
    `);
    await connection().execute(`
      create trigger reject_refund_outbox_trigger
      before insert on outbox_messages
      for each row execute function reject_refund_outbox()
    `);
    try {
      await expect(
        useCase.execute(
          processInput(
            wallet,
            WagerTransactionKind.REFUND,
            "20.00",
            `refund-rollback-${randomUUID()}`,
            `external-${betIdentity}`,
          ),
        ),
      ).rejects.toThrow("forced reversal outbox failure");
    } finally {
      await connection().execute(
        "drop trigger reject_refund_outbox_trigger on outbox_messages",
      );
      await connection().execute("drop function reject_refund_outbox()");
    }
    expect(await readWallet(wallet.id)).toEqual({
      balance: "80.00",
      version: "2",
    });
    expect(await countsForPlayer(playerId)).toEqual(beforeCounts);
    expect(await reconstructedBalance(playerId)).toEqual({
      amount: "80.00",
      currency: "BRL",
    });
  });

  const atomicFailurePoints: AtomicFailurePoint[] = [
    {
      name: "after WagerTransaction insert",
      table: "wager_transactions",
      timing: "immediate",
      match: "transaction",
    },
    {
      name: "after Wallet update",
      table: "wallets",
      timing: "immediate",
      match: "wallet",
    },
    {
      name: "after Ledger insert",
      table: "wallet_ledger_entries",
      timing: "immediate",
      match: "ledger",
    },
    {
      name: "during Outbox insert",
      table: "outbox_messages",
      timing: "immediate",
      match: "outbox",
    },
    {
      name: "immediately before COMMIT",
      table: "outbox_messages",
      timing: "deferred",
      match: "outbox",
    },
    {
      name: "after Inbox write before COMMIT",
      table: "inbox_messages",
      timing: "deferred",
      match: "inbox",
    },
  ];

  for (const failurePoint of atomicFailurePoints) {
    test(`atomic failure injection ${failurePoint.name} rolls back the complete SQL unit`, async () => {
      const { playerId, wallet } = await createFundedWallet("100.00");
      const input = processInput(
        wallet,
        WagerTransactionKind.BET,
        "20.00",
        `atomic-${randomUUID()}`,
      );
      const messageId = `atomic-message-${randomUUID()}`;
      const metadata = {
        consumerName: "wager-transaction-consumer.v1",
        messageId,
        payloadHash: createHash("sha256").update(messageId).digest("hex"),
        receivedAt: new Date(),
      };
      const beforeRows = await connection().execute(
        `select
           (select balance from wallets where id = ?) as balance,
           (select version::text from wallets where id = ?) as version,
           (select count(*)::text from wager_transactions where wallet_id = ?) as transactions,
           (select count(*)::text from wallet_ledger_entries where wallet_id = ?) as ledger,
           (select count(*)::text from outbox_messages where payload->>'walletId' = ?) as outbox,
           (select count(*)::text from inbox_messages where message_id = ?) as inbox`,
        [wallet.id, wallet.id, wallet.id, wallet.id, wallet.id, messageId],
      );
      const trigger = await installAtomicFailureTrigger(
        failurePoint,
        wallet.id,
        messageId,
      );
      try {
        if (failurePoint.match === "inbox") {
          await expect(
            processor().executeFromInbox(input, metadata),
          ).rejects.toThrow();
        } else {
          await expect(processor().execute(input)).rejects.toThrow();
        }
      } finally {
        await removeAtomicFailureTrigger({
          ...trigger,
          table: failurePoint.table,
        });
      }
      const afterRows = await connection().execute(
        `select
           (select balance from wallets where id = ?) as balance,
           (select version::text from wallets where id = ?) as version,
           (select count(*)::text from wager_transactions where wallet_id = ?) as transactions,
           (select count(*)::text from wallet_ledger_entries where wallet_id = ?) as ledger,
           (select count(*)::text from outbox_messages where payload->>'walletId' = ?) as outbox,
           (select count(*)::text from inbox_messages where message_id = ?) as inbox`,
        [wallet.id, wallet.id, wallet.id, wallet.id, wallet.id, messageId],
      );
      expect(afterRows).toEqual(beforeRows);
      expect(await readWallet(wallet.id)).toEqual({
        balance: "100.00",
        version: "1",
      });
      expect((await countsForPlayer(playerId)).transactions).toBe(1);
      expect((await countsForPlayer(playerId)).ledger).toBe(1);
      expect((await countsForPlayer(playerId)).outbox).toBe(2);
    });
  }
});
