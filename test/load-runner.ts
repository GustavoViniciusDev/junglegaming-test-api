import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { unlink } from "node:fs/promises";
import os from "node:os";
import { performance } from "node:perf_hooks";
import Decimal from "decimal.js";
import { MikroORM } from "@mikro-orm/postgresql";
import { CreateWallet } from "../src/wallet/application/create-wallet";
import { MikroOrmWalletCreationStore } from "../src/wallet/infrastructure/mikro-orm-wallet-creation-store";
import { databaseConfig } from "../src/infrastructure/database/database.config";
import { parseEnvironment } from "../src/infrastructure/config/environment";

interface WalletFixture {
  id: string;
  playerId: string;
}

interface LoadInput {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: "BET";
  money: { amount: string; currency: string };
}

interface HttpResult {
  status: number;
  durationMs: number;
  body: Record<string, unknown>;
}

interface ScenarioResult {
  name: string;
  requests: number;
  concurrency: number;
  durationSeconds: number;
  requestsPerSecond: number;
  successfulResponses: number;
  failedResponses: number;
  errorRate: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
  statuses: Record<string, number>;
  outcomes: Record<string, number>;
  diagnostics: string[];
}

const environment = parseEnvironment(process.env);
const config = {
  requests: positiveInteger(process.env.LOAD_REQUESTS, 300, "LOAD_REQUESTS"),
  concurrency: positiveInteger(
    process.env.LOAD_CONCURRENCY,
    20,
    "LOAD_CONCURRENCY",
  ),
  wallets: positiveInteger(process.env.LOAD_WALLETS, 30, "LOAD_WALLETS"),
  hotRequests: positiveInteger(
    process.env.LOAD_HOT_REQUESTS,
    200,
    "LOAD_HOT_REQUESTS",
  ),
  replayRequests: positiveInteger(
    process.env.LOAD_REPLAY_REQUESTS,
    200,
    "LOAD_REPLAY_REQUESTS",
  ),
  replayKeys: positiveInteger(
    process.env.LOAD_REPLAY_KEYS,
    20,
    "LOAD_REPLAY_KEYS",
  ),
  warmupRequests: positiveInteger(
    process.env.LOAD_WARMUP_REQUESTS,
    10,
    "LOAD_WARMUP_REQUESTS",
  ),
  amount: process.env.LOAD_BET_AMOUNT ?? "1.00",
  outboxPublisherEnabled:
    (process.env.LOAD_OUTBOX_PUBLISHER_ENABLED ?? "true") === "true",
  drainTimeoutMs: positiveInteger(
    process.env.LOAD_DRAIN_TIMEOUT_MS,
    120_000,
    "LOAD_DRAIN_TIMEOUT_MS",
  ),
};

if (!/^\d+\.\d{2}$/.test(config.amount) || new Decimal(config.amount).lte(0)) {
  throw new Error(
    "LOAD_BET_AMOUNT must be a positive decimal string with two decimal places",
  );
}

function positiveInteger(
  value: string | undefined,
  fallback: number,
  name: string,
): number {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value))
    throw new Error(`${name} must be a positive integer`);
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return parsed;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function queryRows<T extends object>(
  orm: MikroORM,
  sql: string,
  parameters: unknown[] = [],
): Promise<T[]> {
  return (await orm.em.getConnection().execute(sql, parameters)) as T[];
}

async function createWallet(
  orm: MikroORM,
  prefix: string,
  initialBalance: string,
): Promise<WalletFixture> {
  const playerId = `${prefix}-player-${randomUUID()}`;
  const wallet = await new CreateWallet(
    new MikroOrmWalletCreationStore(orm),
  ).execute({
    playerId,
    currency: "BRL",
    initialBalance,
  });
  return { id: wallet.id, playerId };
}

function makeInput(
  wallet: WalletFixture,
  prefix: string,
  index: number,
): LoadInput {
  return {
    providerId: `${prefix}-provider`,
    externalTransactionId: `${prefix}-external-${index}`,
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: `${prefix}-round`,
    gameId: `${prefix}-game`,
    kind: "BET",
    money: { amount: config.amount, currency: "BRL" },
  };
}

async function postWager(
  baseUrl: string,
  input: LoadInput,
  key: string,
): Promise<HttpResult> {
  const started = performance.now();
  let response: Response;
  try {
    response = await fetch(`${baseUrl}/wagering/transactions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": key,
      },
      body: JSON.stringify(input),
    });
  } catch (error) {
    return {
      status: 0,
      durationMs: performance.now() - started,
      body: {
        error:
          error instanceof Error ? error.message : "Network request failed",
      },
    };
  }
  const durationMs = performance.now() - started;
  const text = await response.text();
  let body: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(text);
    body =
      typeof parsed === "object" && parsed !== null
        ? (parsed as Record<string, unknown>)
        : { response: text };
  } catch {
    body = { response: text.slice(0, 500) };
  }
  return { status: response.status, durationMs, body };
}

async function runRequests(
  baseUrl: string,
  name: string,
  requests: readonly {
    input: LoadInput;
    key: string;
    replay?: boolean;
    expectedId?: unknown;
  }[],
): Promise<ScenarioResult> {
  const latencies: number[] = [];
  const statuses: Record<string, number> = {};
  const outcomes: Record<string, number> = {};
  const diagnostics: string[] = [];
  let nextIndex = 0;
  const started = performance.now();
  const workerCount = Math.min(config.concurrency, requests.length);
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (true) {
        const index = nextIndex++;
        const request = requests[index];
        if (request === undefined) return;
        const result = await postWager(baseUrl, request.input, request.key);
        latencies.push(result.durationMs);
        const statusKey = String(result.status);
        statuses[statusKey] = (statuses[statusKey] ?? 0) + 1;
        const replay = result.body.idempotentReplay === true;
        const status =
          typeof result.body.status === "string" ? result.body.status : "ERROR";
        const outcome = replay ? "replay" : status.toLowerCase();
        outcomes[outcome] = (outcomes[outcome] ?? 0) + 1;
        const expectedStatus = request.replay === true ? 200 : 201;
        const valid =
          result.status === expectedStatus &&
          (request.replay !== true || replay) &&
          status === "PROCESSED" &&
          (request.expectedId === undefined ||
            result.body.transactionId === request.expectedId);
        if (!valid && diagnostics.length < 8) {
          diagnostics.push(
            `HTTP ${result.status}; expected ${expectedStatus}; outcome ${status}; replay ${replay}`,
          );
        }
      }
    }),
  );
  const durationMs = performance.now() - started;
  latencies.sort((left, right) => left - right);
  const percentile = (fraction: number) =>
    latencies.length === 0
      ? 0
      : (latencies[Math.max(0, Math.ceil(fraction * latencies.length) - 1)] ??
        0);
  const failedResponses =
    requests.length - (outcomes.processed ?? 0) - (outcomes.replay ?? 0);
  return {
    name,
    requests: requests.length,
    concurrency: workerCount,
    durationSeconds: durationMs / 1000,
    requestsPerSecond:
      durationMs === 0 ? 0 : requests.length / (durationMs / 1000),
    successfulResponses: requests.length - failedResponses,
    failedResponses,
    errorRate: requests.length === 0 ? 0 : failedResponses / requests.length,
    p50Ms: percentile(0.5),
    p95Ms: percentile(0.95),
    p99Ms: percentile(0.99),
    maxMs: latencies.at(-1) ?? 0,
    statuses,
    outcomes,
    diagnostics,
  };
}

async function assertWalletsCorrect(
  orm: MikroORM,
  wallets: readonly WalletFixture[],
  expectedBalances: ReadonlyMap<string, string>,
  expectedVersions: ReadonlyMap<string, number>,
  expectedTransactions: ReadonlyMap<string, number>,
  expectedLedgers: ReadonlyMap<string, number>,
): Promise<void> {
  for (const wallet of wallets) {
    const rows = await queryRows<{
      balance: string;
      version: number | string;
      currency: string;
      transactions: string;
      ledgers: string;
    }>(
      orm,
      `select w.balance, w.version, w.currency,
         (select count(*)::text from wager_transactions t where t.wallet_id = w.id) as transactions,
         (select count(*)::text from wallet_ledger_entries l where l.wallet_id = w.id) as ledgers
       from wallets w where w.id = ?`,
      [wallet.id],
    );
    const row = rows[0];
    assert(row !== undefined, `Wallet ${wallet.id} is missing after load`);
    const entries = await queryRows<{
      id: string;
      transaction_id: string;
      direction: string;
      amount: string;
      currency: string;
      balance_before: string;
      balance_after: string;
    }>(
      orm,
      `select id, transaction_id, direction, amount, currency, balance_before, balance_after
       from wallet_ledger_entries where wallet_id = ? order by created_at asc, id asc`,
      [wallet.id],
    );
    let calculated = new Decimal("0.00");
    const transactionIds = new Set<string>();
    for (const entry of entries) {
      assert(
        entry.currency === row.currency,
        `Ledger currency mismatch for ${wallet.id}`,
      );
      assert(
        new Decimal(entry.balance_before).equals(calculated),
        `Ledger chain break for ${wallet.id}`,
      );
      calculated =
        entry.direction === "CREDIT"
          ? calculated.plus(entry.amount)
          : calculated.minus(entry.amount);
      assert(
        calculated.greaterThanOrEqualTo(0),
        `Ledger reconstructed a negative balance for ${wallet.id}`,
      );
      assert(
        calculated.equals(entry.balance_after),
        `Ledger arithmetic mismatch for ${wallet.id}`,
      );
      assert(
        !transactionIds.has(entry.transaction_id),
        `Duplicate transaction ledger for ${wallet.id}`,
      );
      transactionIds.add(entry.transaction_id);
    }
    assert(
      calculated.equals(row.balance),
      `Wallet/Ledger mismatch for ${wallet.id}`,
    );
    assert(
      new Decimal(row.balance).greaterThanOrEqualTo(0),
      `Wallet ${wallet.id} is negative`,
    );
    assert(
      row.balance === expectedBalances.get(wallet.id),
      `Unexpected balance for ${wallet.id}`,
    );
    assert(
      Number(row.version) === expectedVersions.get(wallet.id),
      `Unexpected version for ${wallet.id}`,
    );
    assert(
      Number(row.transactions) === expectedTransactions.get(wallet.id),
      `Unexpected transaction count for ${wallet.id}`,
    );
    assert(
      Number(row.ledgers) === expectedLedgers.get(wallet.id),
      `Unexpected ledger count for ${wallet.id}`,
    );
  }
}

async function waitForOutboxDrain(
  baseUrl: string,
): Promise<{ drained: boolean; lagSeconds: number | null }> {
  const deadline = Date.now() + config.drainTimeoutMs;
  let lagSeconds: number | null = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/metrics`);
      if (!response.ok) break;
      const metrics = await response.text();
      const lag = metrics.match(
        /^wagering_outbox_lag_seconds\s+([\d.eE+-]+)$/m,
      );
      lagSeconds = lag === null ? null : Number(lag[1]);
      const pending = await fetch(`${baseUrl}/health/ready`);
      if (pending.ok && lagSeconds === 0) return { drained: true, lagSeconds };
    } catch {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return { drained: false, lagSeconds };
}

async function reservePort(): Promise<number> {
  const { createServer } = await import("node:net");
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  assert(
    address !== null && typeof address !== "string",
    "Could not reserve an application port",
  );
  const port = address.port;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

async function startApplication(databaseName: string): Promise<{
  baseUrl: string;
  stop: () => Promise<void>;
}> {
  const port = await reservePort();
  const child = Bun.spawn([process.execPath, "run", "src/main.ts"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      POSTGRES_DB: databaseName,
      PORT: String(port),
      LOG_LEVEL: "silent",
      SQS_CONSUMER_ENABLED: "false",
      OUTBOX_PUBLISHER_ENABLED: String(config.outboxPublisherEnabled),
    },
    stdout: "ignore",
    stderr: "pipe",
  });
  const baseUrl = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      const details = await new Response(child.stderr).text();
      throw new Error(
        `Load-test application exited during startup: ${details.slice(-2000)}`,
      );
    }
    try {
      const response = await fetch(`${baseUrl}/health/ready`);
      if (response.ok) {
        return {
          baseUrl,
          stop: async () => {
            child.kill("SIGTERM");
            await child.exited;
          },
        };
      }
    } catch {
      // The application is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  child.kill();
  const details = await new Response(child.stderr).text();
  throw new Error(
    `Load-test application did not become ready: ${details.slice(-2000)}`,
  );
}

async function main(): Promise<void> {
  const databaseName = `wg_load_${randomUUID().replaceAll("-", "").slice(0, 24)}`;
  const admin = await MikroORM.init(databaseConfig(environment));
  let testOrm: MikroORM | null = null;
  let createdDatabase = false;
  let application: Awaited<ReturnType<typeof startApplication>> | null = null;
  const startedAt = performance.now();
  try {
    await admin.em.getConnection().execute(`create database "${databaseName}"`);
    createdDatabase = true;
    const testEnvironment = parseEnvironment({
      ...process.env,
      POSTGRES_DB: databaseName,
    });
    testOrm = await MikroORM.init(databaseConfig(testEnvironment));
    await testOrm.getMigrator().up();
    application = await startApplication(databaseName);
    const baseUrl = application.baseUrl;
    const prefix = `load-${randomUUID()}`;
    const liveResponse = await fetch(`${baseUrl}/health/live`);
    const readyResponse = await fetch(`${baseUrl}/health/ready`);
    const baselineMetricsResponse = await fetch(`${baseUrl}/metrics`);
    assert(
      liveResponse.status === 200,
      "Liveness endpoint was not healthy before load",
    );
    assert(
      readyResponse.status === 200,
      "Readiness endpoint was not healthy before load",
    );
    assert(
      baselineMetricsResponse.status === 200,
      "Metrics endpoint was unavailable before load",
    );
    const baselineMetrics = await baselineMetricsResponse.text();
    const expectedMetrics = [
      "wagering_transactions_total",
      "wagering_duplicates_total",
      "wagering_outbox_lag_seconds",
    ];
    assert(
      expectedMetrics.every((metric) => baselineMetrics.includes(metric)),
      "Expected custom Prometheus metrics were missing before load",
    );

    // Warm-up exercises a real HTTP request and its initial database connection outside measured scenarios.
    const warmWallet = await createWallet(
      testOrm,
      `${prefix}-warmup`,
      new Decimal(config.amount).mul(config.warmupRequests + 1).toFixed(2),
    );
    const warmup = Array.from(
      { length: config.warmupRequests },
      (_, index) => ({
        input: makeInput(warmWallet, `${prefix}-warmup`, index),
        key: `${prefix}-warmup-key-${index}`,
      }),
    );
    const warmupResult = await runRequests(baseUrl, "warm-up", warmup);
    assert(warmupResult.failedResponses === 0, "Warm-up request failed");
    await assertWalletsCorrect(
      testOrm,
      [warmWallet],
      new Map([[warmWallet.id, config.amount]]),
      new Map([[warmWallet.id, config.warmupRequests + 1]]),
      new Map([[warmWallet.id, config.warmupRequests + 1]]),
      new Map([[warmWallet.id, config.warmupRequests + 1]]),
    );

    const scenarios: ScenarioResult[] = [];

    const manyPrefix = `${prefix}-many`;
    const manyWallets: WalletFixture[] = [];
    const manyExpectedBalances = new Map<string, string>();
    const manyExpectedVersions = new Map<string, number>();
    const manyExpectedTransactions = new Map<string, number>();
    const manyExpectedLedgers = new Map<string, number>();
    for (let index = 0; index < config.wallets; index++) {
      const count = Math.ceil((config.requests - index) / config.wallets);
      const operationCount = Math.max(0, count);
      const balance = new Decimal(config.amount)
        .mul(operationCount + 1)
        .toFixed(2);
      const wallet = await createWallet(
        testOrm,
        `${manyPrefix}-${index}`,
        balance,
      );
      manyWallets.push(wallet);
      manyExpectedBalances.set(wallet.id, config.amount);
      manyExpectedVersions.set(wallet.id, 1 + operationCount);
      manyExpectedTransactions.set(wallet.id, operationCount + 1);
      manyExpectedLedgers.set(wallet.id, 1 + operationCount);
    }
    const manyRequests = Array.from({ length: config.requests }, (_, index) => {
      const wallet = manyWallets[index % manyWallets.length];
      assert(wallet !== undefined, "Many-wallet fixture is missing");
      return {
        input: makeInput(wallet, manyPrefix, index),
        key: `${manyPrefix}-key-${index}`,
      };
    });
    const manyResult = await runRequests(baseUrl, "many-wallets", manyRequests);
    scenarios.push(manyResult);
    await assertWalletsCorrect(
      testOrm,
      manyWallets,
      manyExpectedBalances,
      manyExpectedVersions,
      manyExpectedTransactions,
      manyExpectedLedgers,
    );
    assert(
      manyResult.failedResponses === 0,
      "Many-wallet workload had failed requests",
    );

    const hotPrefix = `${prefix}-hot`;
    const hotStartingBalance = new Decimal(config.amount)
      .mul(config.hotRequests + 1)
      .toFixed(2);
    const hotWallet = await createWallet(
      testOrm,
      hotPrefix,
      hotStartingBalance,
    );
    const hotRequests = Array.from(
      { length: config.hotRequests },
      (_, index) => ({
        input: makeInput(hotWallet, hotPrefix, index),
        key: `${hotPrefix}-key-${index}`,
      }),
    );
    const hotResult = await runRequests(baseUrl, "hot-wallet", hotRequests);
    scenarios.push(hotResult);
    await assertWalletsCorrect(
      testOrm,
      [hotWallet],
      new Map([[hotWallet.id, config.amount]]),
      new Map([[hotWallet.id, config.hotRequests + 1]]),
      new Map([[hotWallet.id, config.hotRequests + 1]]),
      new Map([[hotWallet.id, config.hotRequests + 1]]),
    );
    assert(
      hotResult.failedResponses === 0,
      "Hot-wallet workload had failed requests",
    );

    const replayPrefix = `${prefix}-replay`;
    const replayKeyCount = Math.min(config.replayKeys, config.replayRequests);
    const replayWallet = await createWallet(
      testOrm,
      replayPrefix,
      new Decimal(config.amount).mul(replayKeyCount + 1).toFixed(2),
    );
    const replayOperations = Array.from(
      { length: replayKeyCount },
      (_, index) => ({
        input: makeInput(replayWallet, replayPrefix, index),
        key: `${replayPrefix}-key-${index}`,
      }),
    );
    const seeds = await Promise.all(
      replayOperations.map((operation) =>
        postWager(baseUrl, operation.input, operation.key),
      ),
    );
    assert(
      seeds.every(
        (seed) =>
          seed.status === 201 && typeof seed.body.transactionId === "string",
      ),
      "Replay scenario seed operation failed",
    );
    const originalIds = seeds.map((seed) => seed.body.transactionId);
    const replayRequests = Array.from(
      { length: config.replayRequests },
      (_, index) => {
        const operationIndex = index % replayOperations.length;
        const operation = replayOperations[operationIndex];
        assert(operation !== undefined, "Replay operation fixture is missing");
        return {
          ...operation,
          replay: true as const,
          expectedId: originalIds[operationIndex],
        };
      },
    );
    const replayResult = await runRequests(
      baseUrl,
      "idempotency-replay",
      replayRequests,
    );
    scenarios.push(replayResult);
    assert(
      replayResult.failedResponses === 0,
      "Replay workload had failed requests",
    );
    await assertWalletsCorrect(
      testOrm,
      [replayWallet],
      new Map([[replayWallet.id, config.amount]]),
      new Map([[replayWallet.id, replayKeyCount + 1]]),
      new Map([[replayWallet.id, replayKeyCount + 1]]),
      new Map([[replayWallet.id, replayKeyCount + 1]]),
    );

    const drain = config.outboxPublisherEnabled
      ? await waitForOutboxDrain(baseUrl)
      : { drained: false, lagSeconds: null };
    const metricsResponse = await fetch(`${baseUrl}/metrics`);
    const metricsText = metricsResponse.ok ? await metricsResponse.text() : "";
    const metricNames = [
      "wagering_transactions_total",
      "wagering_duplicates_total",
      "wagering_lock_conflicts_total",
      "wagering_outbox_lag_seconds",
      "wagering_outbox_publish_total",
      "wagering_processing_duration_seconds_count",
    ];
    const metrics = metricsText
      .split("\n")
      .filter((line) => metricNames.some((name) => line.startsWith(name)));
    const lockConflictMetric =
      metrics.find((line) =>
        line.startsWith("wagering_lock_conflicts_total"),
      ) ??
      "wagering_lock_conflicts_total 0 (no classified lock conflicts observed)";
    const version = await queryRows<{ version: string }>(
      testOrm,
      "select version() as version",
    );
    const durationSeconds = (performance.now() - startedAt) / 1000;
    const report = {
      runtime: { bun: Bun.version, nodeCompatibility: process.versions.node },
      host: {
        platform: os.platform(),
        architecture: os.arch(),
        logicalCpuCount: os.cpus().length,
        totalMemoryBytes: os.totalmem(),
      },
      database: {
        postgresVersion: version[0]?.version ?? "unavailable",
        poolMaxConnections: 10,
      },
      applicationInstances: 1,
      applicationPoolConnections: 10,
      startupChecks: {
        liveStatus: liveResponse.status,
        readyStatus: readyResponse.status,
        metricsStatus: baselineMetricsResponse.status,
        expectedMetricsPresent: expectedMetrics,
      },
      durationSeconds,
      concurrency: config.concurrency,
      outboxPublisherEnabled: config.outboxPublisherEnabled,
      warmupRequests: config.warmupRequests,
      warmupExcludedFromResults: true,
      scenarios,
      outbox: drain,
      metrics,
      lockConflicts: lockConflictMetric,
      financialCorrectness: {
        allScenarioWalletsReconciled: true,
        ledgerChainsValidated: true,
        noNegativeBalances: true,
        replayHadNoAdditionalFinancialEffects: true,
      },
      methodology:
        "Closed-loop HTTP generator with a fixed number of in-flight requests; Bun fetch reuses runtime-managed connections.",
      databaseNameWasTemporary: true,
    };
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } finally {
    if (application !== null) await application.stop();
    if (testOrm !== null) await testOrm.close(true);
    if (createdDatabase) {
      await admin.em
        .getConnection()
        .execute(
          "select pg_terminate_backend(pid) from pg_stat_activity where datname = ? and pid <> pg_backend_pid()",
          [databaseName],
        );
      await admin.em.getConnection().execute(`drop database "${databaseName}"`);
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
          process.stderr.write("Load-test migration snapshot cleanup failed\n");
        }
      }
    }
    await admin.close(true);
  }
}

main().catch((error: unknown) => {
  process.stderr.write(
    error instanceof Error
      ? `${error.name}: ${error.message}\n`
      : "Unknown load-test failure\n",
  );
  process.exitCode = 1;
});
