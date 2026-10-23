import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { unlink } from "node:fs/promises";
import Decimal from "decimal.js";
import { MikroORM } from "@mikro-orm/postgresql";
import { CreateWallet } from "../src/wallet/application/create-wallet";
import { MikroOrmWalletCreationStore } from "../src/wallet/infrastructure/mikro-orm-wallet-creation-store";
import { MikroOrmWalletReconciliationStore } from "../src/wallet/infrastructure/mikro-orm-wallet-reconciliation-store";
import { ReconcileWallet } from "../src/wallet/application/reconcile-wallet";
import { databaseConfig } from "../src/infrastructure/database/database.config";
import { parseEnvironment } from "../src/infrastructure/config/environment";
import { WagerTransactionKind } from "../src/wagering/domain/wager-transaction-kind";
import { WagerTransactionStatus } from "../src/wagering/domain/wager-transaction-status";
import type { ProcessWagerTransactionInput } from "../src/wagering/application/process-wager-transaction";
import {
  assertGlobalFinancialConsistency,
  type GlobalFinancialAuditResult,
} from "./helpers/global-financial-audit";

interface WorkerResult {
  transactionId: string;
  status: WagerTransactionStatus;
  failureCode: string | null;
  walletId: string;
  resultingBalance: { amount: string; currency: string } | null;
  idempotentReplay: boolean;
}

interface WalletFixture {
  id: string;
  playerId: string;
}

const scenarios: string[] = [];
const startedAt = performance.now();
const environment = parseEnvironment(process.env);
let globalFinancialAudit: GlobalFinancialAuditResult | null = null;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function makeInput(
  wallet: WalletFixture,
  identity: string,
  amount: string,
  kind: WagerTransactionKind = WagerTransactionKind.BET,
  referenceExternalTransactionId?: string,
): ProcessWagerTransactionInput {
  return {
    providerId: "distributed-test-provider",
    externalTransactionId: identity,
    idempotencyKey: `distributed-key-${identity}`,
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: "distributed-round",
    gameId: "distributed-game",
    kind,
    money: { amount, currency: "BRL" },
    ...(referenceExternalTransactionId === undefined
      ? {}
      : { referenceExternalTransactionId }),
  };
}

async function spawnWorker(
  testDatabase: string,
  request: unknown,
  environmentOverrides: Record<string, string> = {},
): Promise<string> {
  const workerEnvironment = {
    ...process.env,
    POSTGRES_DB: testDatabase,
    SQS_CONSUMER_ENABLED: "false",
    OUTBOX_PUBLISHER_ENABLED: "false",
    ...environmentOverrides,
  };
  const child = Bun.spawn(
    [
      process.execPath,
      "run",
      "test/distributed-worker.ts",
      JSON.stringify(request),
    ],
    {
      cwd: process.cwd(),
      env: workerEnvironment,
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const completion = Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    const result = await Promise.race([
      completion,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error("Distributed worker timed out")),
          60_000,
        );
      }),
    ]);
    const [stdout, stderr, exitCode] = result;
    if (exitCode !== 0)
      throw new Error(`Distributed worker failed (${exitCode}): ${stderr}`);
    return stdout;
  } catch (error) {
    child.kill();
    throw error;
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

async function createWallet(
  orm: MikroORM,
  playerId: string,
  initialBalance: string,
): Promise<WalletFixture> {
  const wallet = await new CreateWallet(
    new MikroOrmWalletCreationStore(orm),
  ).execute({ playerId, currency: "BRL", initialBalance });
  return { id: wallet.id, playerId };
}

async function queryRows<T extends object>(
  orm: MikroORM,
  sql: string,
  parameters: unknown[] = [],
): Promise<T[]> {
  return (await orm.em.getConnection().execute(sql, parameters)) as T[];
}

async function assertWalletLedgerInvariant(
  orm: MikroORM,
  walletIds: readonly string[],
): Promise<void> {
  for (const walletId of walletIds) {
    const walletRows = await queryRows<{
      balance: string;
      version: number | string;
      currency: string;
    }>(orm, "select balance, version, currency from wallets where id = ?", [
      walletId,
    ]);
    const wallet = walletRows[0];
    assert(wallet !== undefined, `Wallet ${walletId} is missing`);
    const entries = await queryRows<{
      direction: string;
      amount: string;
      balance_before: string;
      balance_after: string;
      currency: string;
    }>(
      orm,
      `select direction, amount, balance_before, balance_after, currency
       from wallet_ledger_entries where wallet_id = ? order by created_at asc, id asc`,
      [walletId],
    );
    let calculated = new Decimal("0.00");
    for (const entry of entries) {
      assert(
        entry.currency === wallet.currency,
        `Ledger currency mismatch for ${walletId}`,
      );
      assert(
        new Decimal(entry.balance_before).equals(calculated),
        `Ledger chain break for ${walletId}`,
      );
      calculated =
        entry.direction === "CREDIT"
          ? calculated.plus(entry.amount)
          : calculated.minus(entry.amount);
      assert(
        calculated.greaterThanOrEqualTo("0"),
        `Negative reconstructed balance for ${walletId}`,
      );
      assert(
        calculated.equals(entry.balance_after),
        `Ledger arithmetic mismatch for ${walletId}`,
      );
    }
    assert(
      calculated.equals(wallet.balance),
      `Wallet/Ledger mismatch for ${walletId}`,
    );
    assert(
      new Decimal(wallet.balance).greaterThanOrEqualTo("0"),
      `Negative wallet balance for ${walletId}`,
    );
  }
}

async function rowCounts(orm: MikroORM, walletId: string) {
  const rows = await queryRows<{
    transactions: string;
    ledgers: string;
    outbox: string;
    balance: string;
    version: number | string;
  }>(
    orm,
    `select
       (select count(*)::text from wager_transactions where wallet_id = ?) as transactions,
       (select count(*)::text from wallet_ledger_entries where wallet_id = ?) as ledgers,
       (select count(*)::text from outbox_messages
        where aggregate_id = ? or aggregate_id in
          (select id from wager_transactions where wallet_id = ?)) as outbox,
       (select balance from wallets where id = ?) as balance,
       (select version from wallets where id = ?) as version`,
    [walletId, walletId, walletId, walletId, walletId, walletId],
  );
  return rows[0];
}

async function runSqsCommitAckCrash(
  orm: MikroORM,
  testDatabase: string,
): Promise<void> {
  const {
    CreateQueueCommand,
    DeleteQueueCommand,
    SendMessageCommand,
    SQSClient,
  } = await import("@aws-sdk/client-sqs");
  const sqs = new SQSClient({
    region: environment.AWS_REGION,
    endpoint: environment.SQS_ENDPOINT,
    credentials: {
      accessKeyId: environment.AWS_ACCESS_KEY_ID,
      secretAccessKey: environment.AWS_SECRET_ACCESS_KEY,
    },
    maxAttempts: 1,
  });
  const queueName = `phase15-${randomUUID().replaceAll("-", "").slice(0, 18)}.fifo`;
  let queueUrl: string | undefined;
  try {
    const queue = await sqs.send(
      new CreateQueueCommand({
        QueueName: queueName,
        Attributes: {
          FifoQueue: "true",
          ContentBasedDeduplication: "false",
          VisibilityTimeout: "1",
        },
      }),
    );
    queueUrl = queue.QueueUrl;
    assert(queueUrl !== undefined, "Crash-test SQS queue was not created");
    const wallet = await createWallet(
      orm,
      `distributed-${randomUUID()}`,
      "100.00",
    );
    const input = makeInput(wallet, `sqs-crash-${randomUUID()}`, "20.00");
    const envelope = {
      messageId: `message-${randomUUID()}`,
      type: "wager.transaction.requested.v1",
      occurredAt: new Date().toISOString(),
      data: input,
    };
    await sqs.send(
      new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: JSON.stringify(envelope),
        MessageGroupId: wallet.id,
        MessageDeduplicationId: envelope.messageId,
      }),
    );
    const child = Bun.spawn(
      [
        process.execPath,
        "run",
        "test/distributed-worker.ts",
        JSON.stringify({ action: "consume", queueUrl, crashAfterCommit: true }),
      ],
      {
        cwd: process.cwd(),
        env: { ...process.env, POSTGRES_DB: testDatabase },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const reader = child.stdout.getReader();
    const decoder = new TextDecoder();
    let output = "";
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        (async () => {
          while (true) {
            const chunk = await reader.read();
            if (chunk.done)
              throw new Error("Consumer exited before SQL commit");
            output += decoder.decode(chunk.value, { stream: true });
            if (output.includes('"committed":true')) return;
          }
        })(),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(
            () => reject(new Error("Consumer commit marker timed out")),
            30_000,
          );
        }),
      ]);
      child.kill();
      await child.exited;
    } catch (error) {
      child.kill();
      throw error;
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
      reader.releaseLock();
    }
    const committed = await rowCounts(orm, wallet.id);
    assert(
      committed?.balance === "80.00",
      "Committed debit was lost after consumer termination",
    );
    const inboxRows = await queryRows<{ processed_at: Date | string | null }>(
      orm,
      "select processed_at from inbox_messages where message_id = ?",
      [envelope.messageId],
    );
    assert(
      inboxRows[0]?.processed_at !== null,
      "Inbox did not commit before consumer termination",
    );
    const replay = JSON.parse(
      await spawnWorker(testDatabase, { action: "consume", queueUrl }),
    ) as { committed: boolean; inboxDuplicate: boolean };
    assert(
      replay.committed && replay.inboxDuplicate,
      "Visibility redelivery was not recognized as an Inbox duplicate",
    );
    const afterReplay = await rowCounts(orm, wallet.id);
    assert(afterReplay?.balance === "80.00", "Redelivery duplicated the debit");
    assert(
      afterReplay?.transactions === "2",
      "Redelivery duplicated the wager transaction",
    );
    assert(
      afterReplay?.ledgers === "2",
      "Redelivery duplicated the ledger entry",
    );
    assert(
      afterReplay?.outbox === "4",
      "Redelivery duplicated financial outbox events",
    );
    await assertWalletLedgerInvariant(orm, [wallet.id]);
    scenarios.push(
      "process termination after COMMIT before ACK with LocalStack visibility redelivery",
    );

    const distinctTransportReplay = {
      ...envelope,
      messageId: `message-new-transport-${randomUUID()}`,
    };
    await sqs.send(
      new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: JSON.stringify(distinctTransportReplay),
        MessageGroupId: wallet.id,
        MessageDeduplicationId: distinctTransportReplay.messageId,
      }),
    );
    const businessReplay = JSON.parse(
      await spawnWorker(testDatabase, { action: "consume", queueUrl }),
    ) as { committed: boolean; inboxDuplicate: boolean };
    assert(
      businessReplay.committed,
      "Distinct transport identity did not commit its Inbox",
    );
    assert(
      !businessReplay.inboxDuplicate,
      "Distinct transport identity was incorrectly treated as an Inbox duplicate",
    );
    const afterDistinctTransportReplay = await rowCounts(orm, wallet.id);
    assert(
      afterDistinctTransportReplay?.balance === "80.00" &&
        afterDistinctTransportReplay.transactions === "2" &&
        afterDistinctTransportReplay.ledgers === "2" &&
        afterDistinctTransportReplay.outbox === "4",
      "Distinct messageId replay duplicated a financial effect",
    );
    assert(
      (
        await queryRows<{ count: string }>(
          orm,
          "select count(*)::text as count from inbox_messages where consumer_name = 'wager-transaction-consumer.v1' and message_id in (?, ?)",
          [envelope.messageId, distinctTransportReplay.messageId],
        )
      )[0]?.count === "2",
      "Distinct transport identities were not persisted separately in Inbox",
    );
    scenarios.push(
      "committed crash redelivery followed by a distinct messageId converged through business idempotency",
    );

    const uncommittedWallet = await createWallet(
      orm,
      `distributed-${randomUUID()}`,
      "100.00",
    );
    const uncommittedInput = makeInput(
      uncommittedWallet,
      `sqs-before-commit-${randomUUID()}`,
      "20.00",
    );
    const uncommittedEnvelope = {
      messageId: `message-${randomUUID()}`,
      type: "wager.transaction.requested.v1",
      occurredAt: new Date().toISOString(),
      data: uncommittedInput,
    };
    await sqs.send(
      new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: JSON.stringify(uncommittedEnvelope),
        MessageGroupId: uncommittedWallet.id,
        MessageDeduplicationId: uncommittedEnvelope.messageId,
      }),
    );
    await orm.em.getConnection().execute(`
      create function phase15_pause_outbox_insert() returns trigger language plpgsql as $$
      begin perform pg_sleep(30); return new; end;
      $$
    `);
    await orm.em.getConnection().execute(`
      create trigger phase15_pause_outbox_insert before insert on outbox_messages
      for each row execute function phase15_pause_outbox_insert()
    `);
    const uncommittedWorker = Bun.spawn(
      [
        process.execPath,
        "run",
        "test/distributed-worker.ts",
        JSON.stringify({ action: "consume", queueUrl }),
      ],
      {
        cwd: process.cwd(),
        env: { ...process.env, POSTGRES_DB: testDatabase },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    let reachedUncommittedWrite = false;
    try {
      for (let attempt = 0; attempt < 300; attempt += 1) {
        const sleepingBackend = await queryRows<{ pid: number }>(
          orm,
          `select pid from pg_stat_activity
           where datname = ? and wait_event = 'PgSleep'
             and query ilike '%outbox_messages%' and pid <> pg_backend_pid()`,
          [testDatabase],
        );
        if (sleepingBackend.length > 0) {
          reachedUncommittedWrite = true;
          break;
        }
        if (uncommittedWorker.exitCode !== null) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert(
        reachedUncommittedWrite,
        "Consumer did not enter the pre-commit database write",
      );
      uncommittedWorker.kill();
      await uncommittedWorker.exited;
    } finally {
      uncommittedWorker.kill();
      await orm.em
        .getConnection()
        .execute(
          "drop trigger if exists phase15_pause_outbox_insert on outbox_messages",
        );
      await orm.em
        .getConnection()
        .execute("drop function if exists phase15_pause_outbox_insert()");
    }
    const rolledBack = await rowCounts(orm, uncommittedWallet.id);
    assert(
      rolledBack?.balance === "100.00",
      "Pre-commit process kill left a partial balance mutation",
    );
    assert(
      String(rolledBack?.version) === "1",
      "Pre-commit process kill left a partial version update",
    );
    assert(
      rolledBack?.transactions === "1",
      "Pre-commit process kill left a transaction row",
    );
    assert(
      rolledBack?.ledgers === "1",
      "Pre-commit process kill left a ledger row",
    );
    const uncommittedInboxRows = await queryRows<{ count: string }>(
      orm,
      "select count(*)::text as count from inbox_messages where message_id = ?",
      [uncommittedEnvelope.messageId],
    );
    assert(
      uncommittedInboxRows[0]?.count === "0",
      "Pre-commit process kill left an Inbox row",
    );
    const recoveredDelivery = JSON.parse(
      await spawnWorker(testDatabase, { action: "consume", queueUrl }),
    ) as { committed: boolean; inboxDuplicate: boolean };
    assert(
      recoveredDelivery.committed,
      "Message was not processed after pre-commit crash redelivery",
    );
    const afterRecovery = await rowCounts(orm, uncommittedWallet.id);
    assert(
      afterRecovery?.balance === "80.00",
      "Redelivery after pre-commit crash did not apply exactly one debit",
    );
    await assertWalletLedgerInvariant(orm, [uncommittedWallet.id]);
    scenarios.push(
      "process termination during SQL write before COMMIT with redelivery recovery",
    );

    const outageWallet = await createWallet(
      orm,
      `distributed-${randomUUID()}`,
      "100.00",
    );
    const outageInput = makeInput(
      outageWallet,
      `postgres-unavailable-${randomUUID()}`,
      "20.00",
    );
    const outageEnvelope = {
      messageId: `message-${randomUUID()}`,
      type: "wager.transaction.requested.v1",
      occurredAt: new Date().toISOString(),
      data: outageInput,
    };
    await sqs.send(
      new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: JSON.stringify(outageEnvelope),
        MessageGroupId: outageWallet.id,
        MessageDeduplicationId: outageEnvelope.messageId,
      }),
    );
    let databaseFailureObserved = false;
    try {
      await spawnWorker(
        testDatabase,
        { action: "consume", queueUrl },
        { POSTGRES_PORT: "1" },
      );
    } catch {
      databaseFailureObserved = true;
    }
    assert(
      databaseFailureObserved,
      "Closed PostgreSQL port did not fail SQS processing",
    );
    const stateDuringOutage = await rowCounts(orm, outageWallet.id);
    assert(
      stateDuringOutage?.balance === "100.00",
      "PostgreSQL outage changed Wallet balance",
    );
    const outageInbox = await queryRows<{ count: string }>(
      orm,
      "select count(*)::text as count from inbox_messages where message_id = ?",
      [outageEnvelope.messageId],
    );
    assert(
      outageInbox[0]?.count === "0",
      "PostgreSQL outage committed Inbox state",
    );
    const recoveredAfterOutage = JSON.parse(
      await spawnWorker(testDatabase, { action: "consume", queueUrl }),
    ) as { committed: boolean };
    assert(
      recoveredAfterOutage.committed,
      "SQS message was not redelivered after PostgreSQL recovered",
    );
    const stateAfterOutage = await rowCounts(orm, outageWallet.id);
    assert(
      stateAfterOutage?.balance === "80.00",
      "Recovered PostgreSQL did not apply one debit",
    );
    await assertWalletLedgerInvariant(orm, [outageWallet.id]);
    scenarios.push(
      "PostgreSQL connection refusal left SQS unacked; redelivery succeeded after recovery",
    );
  } finally {
    if (queueUrl !== undefined) {
      await sqs.send(new DeleteQueueCommand({ QueueUrl: queueUrl }));
    }
    sqs.destroy();
  }
}

async function killWorkerAtOutput(
  testDatabase: string,
  request: unknown,
  marker: string,
): Promise<void> {
  const child = Bun.spawn(
    [
      process.execPath,
      "run",
      "test/distributed-worker.ts",
      JSON.stringify(request),
    ],
    {
      cwd: process.cwd(),
      env: { ...process.env, POSTGRES_DB: testDatabase },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  let output = "";
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      (async () => {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done)
            throw new Error("Worker exited before its crash marker");
          output += decoder.decode(chunk.value, { stream: true });
          if (output.includes(marker)) return;
        }
      })(),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error("Worker crash marker timed out")),
          30_000,
        );
      }),
    ]);
    child.kill();
    await child.exited;
  } catch (error) {
    child.kill();
    throw error;
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    reader.releaseLock();
  }
}

async function runOutboxProcessCrashScenarios(
  orm: MikroORM,
  testDatabase: string,
): Promise<void> {
  const {
    CreateQueueCommand,
    DeleteQueueCommand,
    ReceiveMessageCommand,
    SQSClient,
  } = await import("@aws-sdk/client-sqs");
  const sqs = new SQSClient({
    region: environment.AWS_REGION,
    endpoint: environment.SQS_ENDPOINT,
    credentials: {
      accessKeyId: environment.AWS_ACCESS_KEY_ID,
      secretAccessKey: environment.AWS_SECRET_ACCESS_KEY,
    },
    maxAttempts: 1,
  });
  const queueUrls: string[] = [];
  const createQueue = async (): Promise<{ name: string; url: string }> => {
    const name = `phase15-events-${randomUUID().replaceAll("-", "").slice(0, 16)}.fifo`;
    const result = await sqs.send(
      new CreateQueueCommand({
        QueueName: name,
        Attributes: {
          FifoQueue: "true",
          ContentBasedDeduplication: "false",
          VisibilityTimeout: "1",
        },
      }),
    );
    assert(result.QueueUrl !== undefined, "Outbox test queue was not created");
    queueUrls.push(result.QueueUrl);
    return { name, url: result.QueueUrl };
  };
  const pendingEventIds = async (walletId: string): Promise<string[]> => {
    const rows = await queryRows<{ id: string }>(
      orm,
      `select id from outbox_messages
       where published_at is null and payload->>'walletId' = ?
       order by occurred_at, id`,
      [walletId],
    );
    return rows.map((row) => row.id);
  };
  const readAvailableEventIds = async (queueUrl: string): Promise<string[]> => {
    const response = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 1,
      }),
    );
    return (response.Messages ?? []).flatMap((message) => {
      if (message.Body === undefined) return [];
      const parsed = JSON.parse(message.Body) as { id?: unknown };
      return typeof parsed.id === "string" ? [parsed.id] : [];
    });
  };
  try {
    await orm.em
      .getConnection()
      .execute(
        "update outbox_messages set published_at = occurred_at where published_at is null",
      );
    const publisherQueue = await createQueue();
    const publisherWallets = await Promise.all(
      Array.from({ length: 4 }, (_, index) =>
        createWallet(orm, `distributed-${randomUUID()}-${index}`, "1.00"),
      ),
    );
    const expectedPublisherIds = (
      await Promise.all(
        publisherWallets.map((wallet) => pendingEventIds(wallet.id)),
      )
    ).flat();
    assert(
      expectedPublisherIds.length === 8,
      "Expected opening events for publisher competition",
    );
    const expectedPublisherPlaceholders = expectedPublisherIds
      .map(() => "?")
      .join(", ");
    await Promise.all([
      spawnWorker(testDatabase, {
        action: "publish",
        queueName: publisherQueue.name,
      }),
      spawnWorker(testDatabase, {
        action: "publish",
        queueName: publisherQueue.name,
      }),
    ]);
    const publishedRows = await queryRows<{
      id: string;
      published_at: Date | string | null;
    }>(
      orm,
      `select id, published_at from outbox_messages where id in (${expectedPublisherPlaceholders})`,
      expectedPublisherIds,
    );
    assert(
      publishedRows.length === 8 &&
        publishedRows.every((row) => row.published_at !== null),
      "Independent publisher processes left outbox messages unpublished",
    );
    const publisherEventIds = await readAvailableEventIds(publisherQueue.url);
    assert(
      expectedPublisherIds.every((id) => publisherEventIds.includes(id)),
      "Concurrent publishers lost an event",
    );
    scenarios.push(
      "two independent Outbox publisher processes published all due events",
    );

    await orm.em
      .getConnection()
      .execute(
        "update outbox_messages set published_at = occurred_at where published_at is null",
      );
    const unavailableQueue = await createQueue();
    const unavailableWallet = await createWallet(
      orm,
      `distributed-${randomUUID()}`,
      "1.00",
    );
    const unavailableIds = await pendingEventIds(unavailableWallet.id);
    const failedPublish = JSON.parse(
      await spawnWorker(
        testDatabase,
        { action: "publish", queueName: unavailableQueue.name },
        { SQS_ENDPOINT: "http://127.0.0.1:1" },
      ),
    ) as { outcomes: Array<{ published: boolean }> };
    assert(
      failedPublish.outcomes.some((outcome) => !outcome.published),
      "Unavailable SQS endpoint was not recorded as a publish failure",
    );
    const failedOutbox = await queryRows<{
      attempts: number;
      published_at: Date | string | null;
    }>(orm, "select attempts, published_at from outbox_messages where id = ?", [
      unavailableIds[0],
    ]);
    assert(
      failedOutbox[0]?.attempts === 1,
      "SQS failure did not increment Outbox attempts",
    );
    assert(
      failedOutbox[0]?.published_at === null,
      "SQS failure marked an event published",
    );
    await spawnWorker(testDatabase, {
      action: "publish",
      queueName: unavailableQueue.name,
    });
    const recoveredSqsFailure = await queryRows<{
      published_at: Date | string | null;
    }>(orm, "select published_at from outbox_messages where id = ?", [
      unavailableIds[0],
    ]);
    assert(
      recoveredSqsFailure[0]?.published_at !== null,
      "Outbox did not recover after SQS endpoint became available",
    );
    scenarios.push(
      "SQS connection refusal persisted retry metadata and publisher recovered",
    );

    await orm.em
      .getConnection()
      .execute(
        "update outbox_messages set published_at = occurred_at where published_at is null",
      );
    const beforeSendQueue = await createQueue();
    const beforeSendWallet = await createWallet(
      orm,
      `distributed-${randomUUID()}`,
      "1.00",
    );
    const beforeSendIds = await pendingEventIds(beforeSendWallet.id);
    assert(
      beforeSendIds.length === 2,
      "Expected two opening Outbox events before publisher crash",
    );
    const beforeSendPlaceholders = beforeSendIds.map(() => "?").join(", ");
    await killWorkerAtOutput(
      testDatabase,
      {
        action: "publish",
        queueName: beforeSendQueue.name,
        crashStage: "before-send",
      },
      '"claimed":true',
    );
    const beforeSendState = await queryRows<{
      attempts: number;
      published_at: Date | string | null;
    }>(orm, "select attempts, published_at from outbox_messages where id = ?", [
      beforeSendIds[0],
    ]);
    assert(
      beforeSendState[0]?.published_at === null,
      "Pre-send process crash marked the event published",
    );
    await spawnWorker(testDatabase, {
      action: "publish",
      queueName: beforeSendQueue.name,
    });
    const beforeSendFinal = await queryRows<{
      published_at: Date | string | null;
    }>(
      orm,
      `select published_at from outbox_messages where id in (${beforeSendPlaceholders})`,
      beforeSendIds,
    );
    assert(
      beforeSendFinal.length === 2 &&
        beforeSendFinal.every((row) => row.published_at !== null),
      "Another publisher did not recover the pre-send crash",
    );
    const beforeSendEvents = await readAvailableEventIds(beforeSendQueue.url);
    assert(
      beforeSendIds.every((id) => beforeSendEvents.includes(id)),
      "Pre-send crash lost a confirmed Outbox event",
    );
    scenarios.push(
      "Outbox process crash before SendMessage recovered by another process",
    );

    await orm.em
      .getConnection()
      .execute(
        "update outbox_messages set published_at = occurred_at where published_at is null",
      );
    const afterSendQueue = await createQueue();
    const afterSendWallet = await createWallet(
      orm,
      `distributed-${randomUUID()}`,
      "1.00",
    );
    const afterSendIds = await pendingEventIds(afterSendWallet.id);
    assert(
      afterSendIds.length === 2,
      "Expected two opening Outbox events before post-send crash",
    );
    const afterSendPlaceholders = afterSendIds.map(() => "?").join(", ");
    await killWorkerAtOutput(
      testDatabase,
      {
        action: "publish",
        queueName: afterSendQueue.name,
        crashStage: "after-send",
      },
      '"sent":true',
    );
    const stableEventId = afterSendIds[0];
    assert(stableEventId !== undefined, "Expected a stable event id");
    const afterSendState = await queryRows<{
      published_at: Date | string | null;
    }>(orm, "select published_at from outbox_messages where id = ?", [
      stableEventId,
    ]);
    assert(
      afterSendState[0]?.published_at === null,
      "Crash after SQS confirmation unexpectedly marked the event published",
    );
    await spawnWorker(testDatabase, {
      action: "publish",
      queueName: afterSendQueue.name,
    });
    const afterSendFinal = await queryRows<{
      published_at: Date | string | null;
    }>(
      orm,
      `select published_at from outbox_messages where id in (${afterSendPlaceholders})`,
      afterSendIds,
    );
    assert(
      afterSendFinal.length === 2 &&
        afterSendFinal.every((row) => row.published_at !== null),
      "Post-send crash did not recover publication state",
    );
    const afterSendEvents = await readAvailableEventIds(afterSendQueue.url);
    assert(
      afterSendEvents.includes(stableEventId),
      "Confirmed SQS event was lost after publisher crash",
    );
    scenarios.push(
      "Outbox process crash after SendMessage before publishedAt; stable event ID recovered at-least-once",
    );
  } finally {
    for (const queueUrl of queueUrls) {
      await sqs.send(new DeleteQueueCommand({ QueueUrl: queueUrl }));
    }
    sqs.destroy();
  }
}

async function runScenarios(
  orm: MikroORM,
  testDatabase: string,
): Promise<void> {
  const duplicateWallet = await createWallet(
    orm,
    `distributed-${randomUUID()}`,
    "100.00",
  );
  const duplicateInput = makeInput(
    duplicateWallet,
    `identical-${randomUUID()}`,
    "20.00",
  );
  const duplicatePartitions = [17, 17, 16].map((count) => ({
    action: "process" as const,
    inputs: Array.from({ length: count }, () => duplicateInput),
  }));
  const duplicateOutputs = await Promise.all(
    duplicatePartitions.map((request) => spawnWorker(testDatabase, request)),
  );
  const duplicateResults = duplicateOutputs.flatMap(
    (output) => (JSON.parse(output) as { results: WorkerResult[] }).results,
  );
  const duplicateCounts = await rowCounts(orm, duplicateWallet.id);
  assert(
    duplicateResults.length === 50,
    "Distributed duplicate workload was incomplete",
  );
  assert(
    duplicateResults.filter((result) => !result.idempotentReplay).length === 1,
    "Expected one non-replay result",
  );
  assert(
    duplicateCounts?.transactions === "2",
    "Identical BETs created more than one wagering transaction in addition to OPENING",
  );
  assert(
    duplicateCounts?.ledgers === "2",
    "Identical BETs created incorrect ledger count including OPENING",
  );
  assert(
    duplicateCounts?.outbox === "4",
    "Identical BETs created duplicate outbox events",
  );
  assert(
    duplicateCounts?.balance === "80.00",
    "Identical BETs debited more than once",
  );
  await assertWalletLedgerInvariant(orm, [duplicateWallet.id]);
  scenarios.push("three-process identical BET replay (50 requests)");

  const competingWallet = await createWallet(
    orm,
    `distributed-${randomUUID()}`,
    "100.00",
  );
  const competingInputs = [
    makeInput(competingWallet, `compete-a-${randomUUID()}`, "80.00"),
    makeInput(competingWallet, `compete-b-${randomUUID()}`, "80.00"),
  ];
  const competingResults = await Promise.all(
    competingInputs.map(
      async (input) =>
        JSON.parse(
          await spawnWorker(testDatabase, {
            action: "process",
            inputs: [input],
          }),
        ) as { results: WorkerResult[] },
    ),
  );
  const results = competingResults.flatMap((result) => result.results);
  assert(
    results.filter(
      (result) => result.status === WagerTransactionStatus.PROCESSED,
    ).length === 1,
    "Expected one competing BET to process",
  );
  assert(
    results.filter(
      (result) =>
        result.status === WagerTransactionStatus.REJECTED &&
        result.failureCode === "INSUFFICIENT_FUNDS",
    ).length === 1,
    "Expected one insufficient-funds rejection",
  );
  const competingCounts = await rowCounts(orm, competingWallet.id);
  assert(
    competingCounts?.balance === "20.00",
    "Competing BET balance is incorrect",
  );
  assert(
    String(competingCounts?.version) === "2",
    "Wallet version must increment only for the balance-changing BET",
  );
  assert(
    competingCounts?.ledgers === "2",
    "Competing BET ledger count is incorrect",
  );
  await assertWalletLedgerInvariant(orm, [competingWallet.id]);
  scenarios.push("two-process competing BET 80/80");

  const hotWallet = await createWallet(
    orm,
    `distributed-${randomUUID()}`,
    "1000.00",
  );
  const hotInputs = Array.from({ length: 60 }, (_, index) =>
    makeInput(hotWallet, `hot-${randomUUID()}-${index}`, "1.00"),
  );
  const hotOutputs = await Promise.all(
    [0, 1, 2].map((processIndex) =>
      spawnWorker(testDatabase, {
        action: "process",
        inputs: hotInputs.filter((_, index) => index % 3 === processIndex),
      }),
    ),
  );
  const hotResults = hotOutputs.flatMap(
    (output) => (JSON.parse(output) as { results: WorkerResult[] }).results,
  );
  const hotCounts = await rowCounts(orm, hotWallet.id);
  assert(
    hotResults.length === 60 &&
      hotResults.every(
        (result) => result.status === WagerTransactionStatus.PROCESSED,
      ),
    "Hot wallet operations did not all process",
  );
  assert(hotCounts?.balance === "940.00", "Hot wallet lost an update");
  assert(
    String(hotCounts?.version) === "61",
    "Hot wallet version did not match 60 balance mutations",
  );
  assert(
    hotCounts?.ledgers === "61",
    "Hot wallet ledger count did not match opening plus operations",
  );
  await assertWalletLedgerInvariant(orm, [hotWallet.id]);
  const hotReconciliation = await new ReconcileWallet(
    new MikroOrmWalletReconciliationStore(orm),
  ).execute(hotWallet.id);
  assert(
    hotReconciliation.consistent &&
      hotReconciliation.difference.amount === "0.00" &&
      hotReconciliation.checkedEntries === 61,
    "Post-concurrency reconciliation did not validate the hot Wallet history",
  );
  scenarios.push("three-process hot Wallet (60 distinct BETs)");
  scenarios.push(
    "real Wallet reconciliation after distributed hot-wallet writes",
  );

  const parallelWallets = await Promise.all(
    Array.from({ length: 6 }, (_, index) =>
      createWallet(orm, `distributed-${randomUUID()}`, "10.00").then(
        (wallet) => ({ wallet, index }),
      ),
    ),
  );
  await Promise.all(
    parallelWallets.map(({ wallet, index }) =>
      spawnWorker(testDatabase, {
        action: "process",
        inputs: [
          makeInput(wallet, `parallel-${randomUUID()}-${index}`, "1.00"),
        ],
      }),
    ),
  );
  await assertWalletLedgerInvariant(
    orm,
    parallelWallets.map(({ wallet }) => wallet.id),
  );
  scenarios.push("independent Wallets progressed in separate processes");

  const noMutationWallet = await createWallet(
    orm,
    `distributed-${randomUUID()}`,
    "10.00",
  );
  const noMutationInputs = [
    makeInput(
      noMutationWallet,
      `loss-${randomUUID()}`,
      "5.00",
      WagerTransactionKind.LOSS,
    ),
    makeInput(noMutationWallet, `rejected-${randomUUID()}`, "20.00"),
    makeInput(
      noMutationWallet,
      `pending-${randomUUID()}`,
      "1.00",
      WagerTransactionKind.REFUND,
      `missing-reference-${randomUUID()}`,
    ),
  ];
  const noMutationOutput = JSON.parse(
    await spawnWorker(testDatabase, {
      action: "process",
      inputs: noMutationInputs,
    }),
  ) as { results: WorkerResult[] };
  assert(
    noMutationOutput.results[0]?.status === WagerTransactionStatus.PROCESSED,
    "LOSS did not process",
  );
  assert(
    noMutationOutput.results[1]?.status === WagerTransactionStatus.REJECTED,
    "Insufficient-funds BET was not rejected",
  );
  assert(
    noMutationOutput.results[2]?.status ===
      WagerTransactionStatus.PENDING_REFERENCE,
    "Missing reference did not remain pending",
  );
  const noMutationCounts = await rowCounts(orm, noMutationWallet.id);
  assert(
    noMutationCounts?.balance === "10.00",
    "Non-mutating outcomes changed Wallet balance",
  );
  assert(
    String(noMutationCounts?.version) === "1",
    "LOSS, rejection, or pending reference changed Wallet version",
  );
  assert(
    noMutationCounts?.ledgers === "1",
    "Non-mutating outcomes created Ledger entries beyond OPENING",
  );
  await assertWalletLedgerInvariant(orm, [noMutationWallet.id]);
  scenarios.push(
    "LOSS, REJECTED and PENDING_REFERENCE preserve Wallet version",
  );

  const refundWallet = await createWallet(
    orm,
    `distributed-${randomUUID()}`,
    "100.00",
  );
  const bet = makeInput(refundWallet, `refund-base-${randomUUID()}`, "20.00");
  await spawnWorker(testDatabase, { action: "process", inputs: [bet] });
  const refundInputs = Array.from({ length: 20 }, (_, index) =>
    makeInput(
      refundWallet,
      `refund-${randomUUID()}-${index}`,
      "20.00",
      WagerTransactionKind.REFUND,
      bet.externalTransactionId,
    ),
  );
  const refundOutputs = await Promise.all(
    [0, 1, 2].map((processIndex) =>
      spawnWorker(testDatabase, {
        action: "process",
        inputs: refundInputs.filter((_, index) => index % 3 === processIndex),
      }),
    ),
  );
  const refundResults = refundOutputs.flatMap(
    (output) => (JSON.parse(output) as { results: WorkerResult[] }).results,
  );
  assert(
    refundResults.filter(
      (result) => result.status === WagerTransactionStatus.PROCESSED,
    ).length === 1,
    "Concurrent distributed REFUNDs were not unique",
  );
  assert(
    refundResults.filter((result) => result.failureCode === "ALREADY_REFUNDED")
      .length === 19,
    "Concurrent REFUND losers had unexpected outcomes",
  );
  await assertWalletLedgerInvariant(orm, [refundWallet.id]);
  scenarios.push("three-process concurrent REFUND uniqueness (20 requests)");

  const rollbackWallet = await createWallet(
    orm,
    `distributed-${randomUUID()}`,
    "100.00",
  );
  const rollbackBet = makeInput(
    rollbackWallet,
    `rollback-base-${randomUUID()}`,
    "20.00",
  );
  await spawnWorker(testDatabase, { action: "process", inputs: [rollbackBet] });
  const rollbackInputs = Array.from({ length: 20 }, (_, index) =>
    makeInput(
      rollbackWallet,
      `rollback-${randomUUID()}-${index}`,
      "20.00",
      WagerTransactionKind.ROLLBACK,
      rollbackBet.externalTransactionId,
    ),
  );
  const rollbackOutputs = await Promise.all(
    [0, 1, 2].map((processIndex) =>
      spawnWorker(testDatabase, {
        action: "process",
        inputs: rollbackInputs.filter((_, index) => index % 3 === processIndex),
      }),
    ),
  );
  const rollbackResults = rollbackOutputs.flatMap(
    (output) => (JSON.parse(output) as { results: WorkerResult[] }).results,
  );
  assert(
    rollbackResults.filter(
      (result) => result.status === WagerTransactionStatus.PROCESSED,
    ).length === 1,
    "Concurrent distributed ROLLBACKs were not unique",
  );
  assert(
    rollbackResults.filter(
      (result) => result.failureCode === "ALREADY_ROLLED_BACK",
    ).length === 19,
    "Concurrent ROLLBACK losers had unexpected outcomes",
  );
  await assertWalletLedgerInvariant(orm, [rollbackWallet.id]);
  scenarios.push("three-process concurrent ROLLBACK uniqueness (20 requests)");

  const recoveryWallet = await createWallet(
    orm,
    `distributed-${randomUUID()}`,
    "100.00",
  );
  const reference = makeInput(
    recoveryWallet,
    `recovery-base-${randomUUID()}`,
    "20.00",
  );
  const pendingRefund = makeInput(
    recoveryWallet,
    `recovery-refund-${randomUUID()}`,
    "20.00",
    WagerTransactionKind.REFUND,
    reference.externalTransactionId,
  );
  const pendingOutput = JSON.parse(
    await spawnWorker(testDatabase, {
      action: "process",
      inputs: [pendingRefund],
    }),
  ) as { results: WorkerResult[] };
  assert(
    pendingOutput.results[0]?.status ===
      WagerTransactionStatus.PENDING_REFERENCE,
    "Out-of-order REFUND did not become pending",
  );
  await spawnWorker(testDatabase, { action: "process", inputs: [reference] });
  const recoveryOutput = JSON.parse(
    await spawnWorker(testDatabase, { action: "recover" }),
  ) as { recovered: number };
  assert(
    recoveryOutput.recovered >= 1,
    "Independent process did not recover pending reference",
  );
  const recoveredRows = await queryRows<{ id: string; status: string }>(
    orm,
    "select id, status from wager_transactions where external_transaction_id = ?",
    [pendingRefund.externalTransactionId],
  );
  assert(
    recoveredRows[0]?.id === pendingOutput.results[0]?.transactionId,
    "Recovery did not continue the original transaction",
  );
  assert(
    recoveredRows[0]?.status === WagerTransactionStatus.PROCESSED,
    "Pending reference did not reach PROCESSED",
  );
  await assertWalletLedgerInvariant(orm, [recoveryWallet.id]);
  scenarios.push("out-of-order reference recovered by a different process");

  const recoveryFixtures = await Promise.all(
    Array.from({ length: 2 }, async () => {
      const wallet = await createWallet(
        orm,
        `distributed-${randomUUID()}`,
        "100.00",
      );
      const referenceInput = makeInput(
        wallet,
        `parallel-recovery-bet-${randomUUID()}`,
        "10.00",
      );
      const dependentInput = makeInput(
        wallet,
        `parallel-recovery-refund-${randomUUID()}`,
        "10.00",
        WagerTransactionKind.REFUND,
        referenceInput.externalTransactionId,
      );
      await spawnWorker(testDatabase, {
        action: "process",
        inputs: [dependentInput],
      });
      await spawnWorker(testDatabase, {
        action: "process",
        inputs: [referenceInput],
      });
      return { wallet, dependentInput };
    }),
  );
  const parallelRecoveryRuns = await Promise.all(
    [0, 1].map(() => spawnWorker(testDatabase, { action: "recover" })),
  );
  const recoveredCount = parallelRecoveryRuns.reduce(
    (total, output) =>
      total + (JSON.parse(output) as { recovered: number }).recovered,
    0,
  );
  assert(
    recoveredCount >= 2,
    "Independent recovery processes did not claim both target pending transactions",
  );
  for (const fixture of recoveryFixtures) {
    const statusRows = await queryRows<{ status: string }>(
      orm,
      "select status from wager_transactions where external_transaction_id = ?",
      [fixture.dependentInput.externalTransactionId],
    );
    assert(
      statusRows[0]?.status === WagerTransactionStatus.PROCESSED,
      "Concurrent recovery worker left a transaction pending",
    );
    await assertWalletLedgerInvariant(orm, [fixture.wallet.id]);
  }
  scenarios.push(
    "two independent recovery worker processes divided pending transactions",
  );

  await runSqsCommitAckCrash(orm, testDatabase);
  await runOutboxProcessCrashScenarios(orm, testDatabase);
  const allWallets = await queryRows<{ id: string }>(
    orm,
    "select id from wallets order by id",
  );
  const walletIds = allWallets.map((wallet) => wallet.id);
  await assertWalletLedgerInvariant(orm, walletIds);
  globalFinancialAudit = await assertGlobalFinancialConsistency(orm);
  scenarios.push(
    `global financial audit (${globalFinancialAudit.walletsChecked} Wallets, ${globalFinancialAudit.transactionsChecked} transactions, ${globalFinancialAudit.ledgerEntriesChecked} Ledger entries)`,
  );
}

async function main(): Promise<void> {
  const databaseName = `wg_dist_${randomUUID().replaceAll("-", "").slice(0, 24)}`;
  const admin = await MikroORM.init(databaseConfig(environment));
  let testOrm: MikroORM | null = null;
  let createdDatabase = false;
  let snapshotCleanupError: unknown;
  try {
    await admin.em.getConnection().execute(`create database "${databaseName}"`);
    createdDatabase = true;
    const testEnvironment = parseEnvironment({
      ...process.env,
      POSTGRES_DB: databaseName,
    });
    testOrm = await MikroORM.init(databaseConfig(testEnvironment));
    await testOrm.getMigrator().up();
    await runScenarios(testOrm, databaseName);
  } finally {
    try {
      if (testOrm !== null) await testOrm.close(true);
    } finally {
      try {
        if (createdDatabase) {
          await admin.em
            .getConnection()
            .execute(
              "select pg_terminate_backend(pid) from pg_stat_activity where datname = ? and pid <> pg_backend_pid()",
              [databaseName],
            );
          await admin.em
            .getConnection()
            .execute(`drop database "${databaseName}"`);
          createdDatabase = false;
          try {
            await unlink(
              `src/infrastructure/database/migrations/.snapshot-${databaseName}.json`,
            );
          } catch (error) {
            if (
              !(
                error instanceof Error &&
                "code" in error &&
                error.code === "ENOENT"
              )
            ) {
              snapshotCleanupError = error;
            }
          }
        }
      } finally {
        await admin.close(true);
      }
    }
  }
  if (snapshotCleanupError !== undefined) throw snapshotCleanupError;
  const durationSeconds = ((performance.now() - startedAt) / 1000).toFixed(1);
  process.stdout.write(
    `${JSON.stringify({ scenariosPassed: scenarios.length, scenarios, globalFinancialAudit, osProcesses: "3 independent Bun worker processes per distributed batch", durationSeconds })}\n`,
  );
}

main().catch((error: unknown) => {
  process.stderr.write(
    error instanceof Error
      ? `${error.name}: ${error.message}\n`
      : "Unknown distributed test failure\n",
  );
  process.exitCode = 1;
});
