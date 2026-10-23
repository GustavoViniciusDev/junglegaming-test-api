import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { readdir, readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { MikroORM } from "@mikro-orm/postgresql";
import { GetQueueUrlCommand, SQSClient } from "@aws-sdk/client-sqs";
import { databaseConfig } from "../src/infrastructure/database/database.config";
import { parseEnvironment } from "../src/infrastructure/config/environment";
import type { GlobalFinancialAuditResult } from "./helpers/global-financial-audit";

type ScenarioResult = {
  name: string;
  result: "PASS" | "FAIL" | "WARNING";
  durationMs: number;
  assertions: string[];
  errorSummary?: string;
};

type AcceptanceReport = {
  timestamp: string;
  environment: Record<string, unknown>;
  scenarios: ScenarioResult[];
  warnings: string[];
  errors: string[];
  executionBreakdown: {
    regressionTests: Record<
      string,
      { passed: number; failed: number; skipped: number }
    >;
    adversarialChecks: {
      globalFinancialAudits: Array<{
        source: string;
        result: GlobalFinancialAuditResult;
      }>;
      atomicFailurePoints: string[];
      sqsIdentityCases: Array<Record<string, unknown>>;
      staticAudits: string[];
      infrastructurePreflight: string[];
    };
  };
  financialInvariants: Record<string, "PASS" | "NOT_VERIFIED">;
  summary: {
    totalCommandChecks: number;
    passed: number;
    failed: number;
    warnings: number;
    durationMs: number;
  };
};

const startedAt = performance.now();
const report: AcceptanceReport = {
  timestamp: new Date().toISOString(),
  environment: {
    bunVersion: Bun.version,
    operatingSystem: os.platform(),
    architecture: os.arch(),
    applicationMode:
      "NestJS HTTP integration plus a real application process in the load harness",
    applicationInstances: 1,
    distributedWorkerProcesses: 3,
    databaseTestName: null,
    postgresVersion: null,
    localStackAvailable: false,
    queueNames: [],
  },
  scenarios: [],
  warnings: [],
  errors: [],
  executionBreakdown: {
    regressionTests: {},
    adversarialChecks: {
      globalFinancialAudits: [],
      atomicFailurePoints: [],
      sqsIdentityCases: [],
      staticAudits: [],
      infrastructurePreflight: [],
    },
  },
  financialInvariants: {},
  summary: {
    totalCommandChecks: 0,
    passed: 0,
    failed: 0,
    warnings: 0,
    durationMs: 0,
  },
};

function recordScenario(
  name: string,
  result: ScenarioResult["result"],
  durationMs: number,
  assertions: string[],
  errorSummary?: string,
): void {
  const scenario: ScenarioResult = {
    name,
    result,
    durationMs: Math.round(durationMs),
    assertions,
    ...(errorSummary === undefined ? {} : { errorSummary }),
  };
  report.scenarios.push(scenario);
  process.stdout.write(`[ACCEPTANCE] ${name}\n`);
  for (const assertion of assertions) {
    process.stdout.write(`[${result}] ${assertion}\n`);
  }
  if (errorSummary !== undefined) {
    process.stdout.write(`Expected: suite success\nActual: ${errorSummary}\n`);
  }
  process.stdout.write(`Duration: ${scenario.durationMs} ms\n`);
}

function redact(text: string): string {
  return text
    .replace(
      /(AWS_SECRET_ACCESS_KEY|POSTGRES_PASSWORD)=[^\s]+/gi,
      "$1=[REDACTED]",
    )
    .replace(/(secretAccessKey|password)\s*[:=]\s*[^,\s}]+/gi, "$1=[REDACTED]")
    .replace(/(Idempotency-Key\s*[:=]\s*)[^\s,}]+/gi, "$1[REDACTED]");
}

function extractTestLines(output: string): {
  passed: Array<{ name: string; durationMs: number }>;
  failed: Array<{ name: string; durationMs: number }>;
  skipped: Array<{ name: string; durationMs: number }>;
} {
  const passed: Array<{ name: string; durationMs: number }> = [];
  const failed: Array<{ name: string; durationMs: number }> = [];
  const skipped: Array<{ name: string; durationMs: number }> = [];
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    const match = line.match(
      /^\((pass|fail|skip)\)\s+(.+?)(?:\s+\[([\d.]+)ms\])?$/,
    );
    if (match === null) continue;
    const [, outcome, testName, duration] = match;
    const item = {
      name: testName ?? "Unnamed test",
      durationMs: Number(duration ?? 0),
    };
    if (outcome === "pass") passed.push(item);
    else if (outcome === "fail") failed.push(item);
    else skipped.push(item);
  }
  return { passed, failed, skipped };
}

async function runCommand(
  label: string,
  args: string[],
  env: Record<string, string>,
  timeoutMs: number,
): Promise<{ exitCode: number; output: string; durationMs: number }> {
  process.stdout.write(`[ACCEPTANCE] Running ${label}\n`);
  const commandStarted = performance.now();
  const child = Bun.spawn([process.execPath, ...args], {
    cwd: process.cwd(),
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
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
          () => reject(new Error(`${label} exceeded its acceptance timeout`)),
          timeoutMs,
        );
      }),
    ]);
    const [stdout, stderr, exitCode] = result;
    return {
      exitCode,
      output: redact(`${stdout}\n${stderr}`),
      durationMs: performance.now() - commandStarted,
    };
  } catch (error) {
    child.kill();
    const message = error instanceof Error ? error.message : "Command failed";
    return {
      exitCode: 1,
      output: message,
      durationMs: performance.now() - commandStarted,
    };
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

async function collectSourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory())
      files.push(...(await collectSourceFiles(fullPath)));
    else if (entry.isFile() && entry.name.endsWith(".ts")) files.push(fullPath);
  }
  return files;
}

async function runStaticAudits(): Promise<boolean> {
  const files = await collectSourceFiles("src");
  const source = await Promise.all(
    files.map(async (file) => ({
      file,
      content: await readFile(file, "utf8"),
    })),
  );
  const issues: string[] = [];

  const domainFiles = source.filter(({ file }) =>
    file.split(path.sep).includes("domain"),
  );
  for (const { file, content } of domainFiles) {
    if (
      /from\s+["'](?:@nestjs\/|@mikro-orm\/|@aws-sdk\/|express|fastify)/.test(
        content,
      )
    ) {
      issues.push(
        `Domain imports infrastructure/framework dependency: ${file}`,
      );
    }
  }

  const financialFiles = source.filter(({ file }) =>
    /(?:wallet|wager|money|ledger)/i.test(file),
  );
  const dangerousMoneyPatterns = [
    /(?:Number|parseFloat|parseInt)\s*\(\s*(?:amount|balance|money)(?:\b|\.)/i,
    /\b(?:amount|balance)\s*:\s*number\b/i,
    /\.toNumber\s*\(/,
    /(?:^|[^=!<>])(?:amount|balance)\s*[+*\-/]=/i,
  ];
  const monetaryConversionLines: string[] = [];
  for (const { file, content } of financialFiles) {
    for (const [lineIndex, line] of content.split(/\r?\n/).entries()) {
      if (dangerousMoneyPatterns.some((pattern) => pattern.test(line))) {
        monetaryConversionLines.push(`${file}:${lineIndex + 1}`);
      }
    }
  }
  if (monetaryConversionLines.length > 0) {
    issues.push(
      `Potential monetary IEEE-754 conversion: ${monetaryConversionLines.join(", ")}`,
    );
  }

  const unsafeOverrides = source.flatMap(({ file, content }) => {
    const matches = content.match(/@ts-ignore|@ts-expect-error/g) ?? [];
    return matches.map(
      () => `TypeScript suppression in production source: ${file}`,
    );
  });
  issues.push(...unsafeOverrides);

  const anyDeclarations = source.flatMap(({ file, content }) => {
    const matches = content.match(/:\s*any\b|\bas\s+any\b/g) ?? [];
    return matches.map(() => `Explicit any in production source: ${file}`);
  });
  issues.push(...anyDeclarations);

  const metricFile = await readFile(
    "src/infrastructure/metrics/wagering-metrics.ts",
    "utf8",
  );
  const forbiddenMetricLabels = [
    "walletId",
    "playerId",
    "transactionId",
    "messageId",
    "idempotencyKey",
  ];
  if (
    forbiddenMetricLabels.some((label) => metricFile.includes(`"${label}"`))
  ) {
    issues.push(
      "High-cardinality identity appears in metric label declarations",
    );
  }

  const processorPath = "src/wagering/application/process-wager-transaction.ts";
  const processor = await readFile(processorPath, "utf8");
  if (/SendMessageCommand|SQSClient|\.send\s*\(/.test(processor)) {
    issues.push(
      "External SQS publication is present in the financial processor",
    );
  }
  const processingAdapterPath =
    "src/wagering/infrastructure/mikro-orm-wager-transaction-processing-store.ts";
  const processingAdapter = await readFile(processingAdapterPath, "utf8");
  if (/new\s+(?:Map|Set)\s*[<(]/.test(`${processor}\n${processingAdapter}`)) {
    issues.push("In-memory Map/Set appears in the financial idempotency path");
  }
  if (
    /\b(?:Mutex|GlobalLock|RedisLock)\b/i.test(
      `${processor}\n${processingAdapter}`,
    )
  ) {
    issues.push(
      "Process-local/global lock abstraction appears in the financial path",
    );
  }

  const productionLedgerMutation = source
    .filter(({ file }) => !file.includes("migration"))
    .flatMap(({ file, content }) => {
      const lines = content.split(/\r?\n/);
      return lines.flatMap((line, index) =>
        /(?:update|delete\s+from)\s+wallet_ledger_entries/i.test(line)
          ? [
              `Ledger mutation statement outside migration: ${file}:${index + 1}`,
            ]
          : [],
      );
    });
  issues.push(...productionLedgerMutation);

  const forbiddenSettings = source.flatMap(({ file, content }) =>
    /synchronize\s*:\s*true|schemaGenerator\s*\(/i.test(content)
      ? [`Automatic schema synchronization pattern: ${file}`]
      : [],
  );
  issues.push(...forbiddenSettings);

  const consoleCalls = source.flatMap(({ file, content }) =>
    /console\.log\s*\(/.test(content)
      ? [`console.log in production source: ${file}`]
      : [],
  );
  issues.push(...consoleCalls);

  const credentialLiterals = source.flatMap(({ file, content }) =>
    /(?:password|secretAccessKey|AWS_SECRET_ACCESS_KEY)\s*[:=]\s*["'][^"']{8,}["']/i.test(
      content,
    )
      ? [`Possible hardcoded credential in production source: ${file}`]
      : [],
  );
  issues.push(...credentialLiterals);

  report.environment.numericConversionOccurrences = source.flatMap(
    ({ file, content }) =>
      content.split(/\r?\n/).flatMap((line, index) => {
        if (!/Number\s*\(|parseFloat\s*\(|parseInt\s*\(/.test(line)) return [];
        const classification =
          /receiveCount|typeof\s+value\s*===\s*["']number["']/.test(line)
            ? "safe non-money transport/serialization handling"
            : /amount|balance|money/i.test(line)
              ? "dangerous monetary conversion candidate"
              : "safe non-money conversion after source review";
        if (classification.startsWith("dangerous")) {
          issues.push(
            `Dangerous numeric conversion candidate: ${file}:${index + 1}`,
          );
        }
        return [{ file, line: index + 1, classification }];
      }),
  );

  const assertions = [
    `Inspected ${files.length} production TypeScript files`,
    `Inspected ${domainFiles.length} domain files for framework/ORM/AWS imports`,
    `Inspected ${financialFiles.length} financial files for unsafe numeric money conversions`,
    "Checked metric label declarations for prohibited high-cardinality IDs",
    "Checked processor for direct SQS publication before commit",
    "Checked production source for Ledger UPDATE/DELETE, schema auto-sync, console.log, suppressions, any, and credential literals",
  ];
  const ok = issues.length === 0;
  recordScenario(
    "Static production safety audit",
    ok ? "PASS" : "FAIL",
    0,
    ok ? assertions : [...assertions, ...issues],
    ok ? undefined : issues.join("; "),
  );
  if (ok) {
    report.executionBreakdown.adversarialChecks.staticAudits.push(
      `Inspected ${files.length} production TypeScript files using the runner's regex/source checks`,
    );
  }
  report.environment.sourceAuditIssues = issues;
  return ok;
}

async function fingerprintAndCreateTestDatabase(): Promise<{
  environment: ReturnType<typeof parseEnvironment>;
  admin: MikroORM;
  databaseName: string;
  sqs: SQSClient;
}> {
  const environment = parseEnvironment(process.env);
  const admin = await MikroORM.init(databaseConfig(environment));
  const databaseName = `wg_accept_${randomUUID().replaceAll("-", "").slice(0, 20)}`;
  const sqs = new SQSClient({
    region: environment.AWS_REGION,
    endpoint: environment.SQS_ENDPOINT,
    credentials: {
      accessKeyId: environment.AWS_ACCESS_KEY_ID,
      secretAccessKey: environment.AWS_SECRET_ACCESS_KEY,
    },
    maxAttempts: 1,
  });
  try {
    const queueNames = [
      environment.SQS_WAGER_TRANSACTION_QUEUE_NAME,
      environment.SQS_WAGER_TRANSACTION_DLQ_NAME,
      environment.SQS_WAGER_EVENTS_QUEUE_NAME,
    ];
    for (const queueName of queueNames) {
      await sqs.send(new GetQueueUrlCommand({ QueueName: queueName }));
    }
    const versionRows = (await admin.em
      .getConnection()
      .execute("select version() as version")) as Array<{ version: string }>;
    await admin.em.getConnection().execute(`create database "${databaseName}"`);
    report.environment = {
      ...report.environment,
      nodeCompatibilityVersion: process.versions.node,
      postgresVersion: versionRows[0]?.version ?? "unknown",
      localStackAvailable: true,
      databaseTestName: databaseName,
      queueNames,
    };
    return { environment, admin, databaseName, sqs };
  } catch (error) {
    sqs.destroy();
    await admin.close(true);
    throw error;
  }
}

async function recordSuiteTests(
  commandLabel: string,
  output: string,
  exitCode: number,
  durationMs: number,
): Promise<ReturnType<typeof extractTestLines>> {
  const parsed = extractTestLines(output);
  const skippedSummary = output.match(/^\s*(\d+)\s+skip\s*$/m);
  const skippedCount = Number(skippedSummary?.[1] ?? parsed.skipped.length);
  for (const test of parsed.passed) {
    recordScenario(`${commandLabel}: ${test.name}`, "PASS", test.durationMs, [
      "Underlying test assertions passed",
    ]);
  }
  for (const test of parsed.failed) {
    const diagnostic = output
      .split(/\r?\n/)
      .filter((line) => /\(fail\)|Expected:|Received:|error:|Error:/.test(line))
      .slice(-8)
      .join(" | ");
    recordScenario(
      `${commandLabel}: ${test.name}`,
      "FAIL",
      test.durationMs,
      ["Underlying test failed"],
      (diagnostic || "Bun test reported failure").slice(0, 1200),
    );
  }
  if (
    parsed.passed.length === 0 &&
    parsed.failed.length === 0 &&
    exitCode === 0
  ) {
    recordScenario(commandLabel, "PASS", durationMs, [
      "Command exited successfully",
    ]);
  }
  if (exitCode !== 0 && parsed.failed.length === 0) {
    const diagnostic =
      output
        .split(/\r?\n/)
        .filter((line) => /error|failed|timeout/i.test(line))
        .slice(-5)
        .join(" | ") || `Command exited with code ${exitCode}`;
    recordScenario(
      commandLabel,
      "FAIL",
      durationMs,
      ["Command exited unsuccessfully"],
      diagnostic.slice(0, 1000),
    );
  }
  if (skippedCount > 0) {
    report.warnings.push(
      `${commandLabel}: ${skippedCount} tests were skipped by their configured guards`,
    );
  }
  return {
    ...parsed,
    skipped: Array.from(
      { length: skippedCount },
      (_, index) =>
        parsed.skipped[index] ?? {
          name: `Skipped test ${index + 1}`,
          durationMs: 0,
        },
    ),
  };
}

function findStructuredJson(
  output: string,
  accepts: (value: Record<string, unknown>) => boolean,
): Record<string, unknown> | null {
  for (
    let start = output.indexOf("{");
    start >= 0;
    start = output.indexOf("{", start + 1)
  ) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < output.length; index += 1) {
      const character = output[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === '"') inString = false;
        continue;
      }
      if (character === '"') inString = true;
      else if (character === "{") depth += 1;
      else if (character === "}") {
        depth -= 1;
        if (depth === 0) {
          try {
            const value = JSON.parse(output.slice(start, index + 1)) as Record<
              string,
              unknown
            >;
            if (accepts(value)) return value;
          } catch {
            // Continue scanning; subprocess output may contain non-JSON braces.
          }
          break;
        }
      }
    }
  }
  return null;
}

function parseMarkedJson(output: string, marker: string): unknown[] {
  return output.split(/\r?\n/).flatMap((line) => {
    const markerIndex = line.indexOf(marker);
    if (markerIndex < 0) return [];
    const jsonStart = line.indexOf("{", markerIndex + marker.length);
    if (jsonStart < 0) return [];
    try {
      return [JSON.parse(line.slice(jsonStart)) as unknown];
    } catch {
      return [];
    }
  });
}

function isGlobalFinancialAuditResult(
  value: unknown,
): value is GlobalFinancialAuditResult {
  if (value === null || typeof value !== "object") return false;
  const audit = value as Partial<GlobalFinancialAuditResult>;
  return (
    Number.isInteger(audit.walletsChecked) &&
    Number.isInteger(audit.transactionsChecked) &&
    Number.isInteger(audit.ledgerEntriesChecked) &&
    audit.checks !== undefined &&
    Object.values(audit.checks).length > 0 &&
    Object.values(audit.checks).every((check) => check === "PASS")
  );
}

function recordGlobalFinancialAudit(
  source: string,
  result: GlobalFinancialAuditResult,
): void {
  report.executionBreakdown.adversarialChecks.globalFinancialAudits.push({
    source,
    result,
  });
}

function recordJsonScenarios(
  label: string,
  output: string,
): Record<string, unknown> | null {
  const value = findStructuredJson(
    output,
    (candidate) =>
      Array.isArray(candidate.scenarios) &&
      candidate.scenarios.every((item) => typeof item === "string"),
  );
  if (value === null || !Array.isArray(value.scenarios)) return null;
  for (const scenario of value.scenarios) {
    recordScenario(`${label}: ${scenario}`, "PASS", 0, [
      "Scenario reported passed by real harness",
    ]);
  }
  if (typeof value.osProcesses === "string") {
    report.environment.distributedProcesses = value.osProcesses;
  }
  const distributedAudit = value.globalFinancialAudit;
  if (!isGlobalFinancialAuditResult(distributedAudit)) return null;
  recordGlobalFinancialAudit("distributed database", distributedAudit);
  return value.scenarios.length > 0 ? value : null;
}

function recordLoadScenarios(output: string): boolean {
  const value = findStructuredJson(
    output,
    (candidate) =>
      typeof candidate.runtime === "object" &&
      Array.isArray(candidate.scenarios),
  ) as {
    scenarios?: Array<{
      name: string;
      requests: number;
      failedResponses: number;
      durationSeconds: number;
      requestsPerSecond: number;
      p95Ms: number;
    }>;
    outbox?: { drained?: boolean; lagSeconds?: number | null };
    financialCorrectness?: Record<string, boolean>;
    startupChecks?: {
      liveStatus: number;
      readyStatus: number;
      metricsStatus: number;
      expectedMetricsPresent: string[];
    };
  } | null;
  if (value === null) return false;
  try {
    let allScenariosValid = (value.scenarios?.length ?? 0) > 0;
    for (const scenario of value.scenarios ?? []) {
      const valid = scenario.failedResponses === 0;
      allScenariosValid = allScenariosValid && valid;
      recordScenario(
        `Load: ${scenario.name}`,
        valid ? "PASS" : "FAIL",
        scenario.durationSeconds * 1000,
        [
          `${scenario.requests} requests; ${scenario.requestsPerSecond.toFixed(2)} RPS; p95 ${scenario.p95Ms.toFixed(2)} ms`,
          `Failed HTTP responses: ${scenario.failedResponses}`,
        ],
        valid ? undefined : "Load workload returned failed HTTP responses",
      );
    }
    if (value.outbox?.drained === true) {
      report.environment.loadOutboxLagSeconds = value.outbox.lagSeconds;
    } else {
      report.warnings.push(
        "Load scenario ended before the Outbox publisher reached zero lag",
      );
    }
    const correctness = value.financialCorrectness ?? {};
    report.environment.loadFinancialCorrectness = correctness;
    const startup = value.startupChecks;
    let startupPassed = false;
    if (startup !== undefined) {
      startupPassed =
        startup.liveStatus === 200 &&
        startup.readyStatus === 200 &&
        startup.metricsStatus === 200 &&
        startup.expectedMetricsPresent.length >= 3;
      recordScenario(
        "Real application baseline health and metrics",
        startupPassed ? "PASS" : "FAIL",
        0,
        [
          `GET /health/live = ${startup.liveStatus}`,
          `GET /health/ready = ${startup.readyStatus}`,
          `GET /metrics = ${startup.metricsStatus}`,
          `Custom metrics present: ${startup.expectedMetricsPresent.join(", ")}`,
        ],
        startupPassed
          ? undefined
          : "Real application baseline health check failed",
      );
    }
    return (
      allScenariosValid &&
      startupPassed &&
      Object.values(correctness).every((result) => result === true)
    );
  } catch {
    return false;
  }
}

async function writeArtifacts(): Promise<void> {
  report.summary = {
    totalCommandChecks: report.scenarios.length,
    passed: report.scenarios.filter((scenario) => scenario.result === "PASS")
      .length,
    failed: report.scenarios.filter((scenario) => scenario.result === "FAIL")
      .length,
    warnings: report.warnings.length,
    durationMs: Math.round(performance.now() - startedAt),
  };
  const outputDirectory = "test-results";
  await mkdir(outputDirectory, { recursive: true });
  await writeFile(
    path.join(outputDirectory, "acceptance-report.json"),
    `${JSON.stringify(report, null, 2)}\n`,
    "utf8",
  );
  const invariantLines = Object.entries(report.financialInvariants).map(
    ([name, result]) => `${result} ${name}`,
  );
  const regressionLines = Object.entries(
    report.executionBreakdown.regressionTests,
  ).map(
    ([name, counts]) =>
      `  ${name}: ${counts.passed} passed, ${counts.failed} failed, ${counts.skipped} skipped`,
  );
  const adversarial = report.executionBreakdown.adversarialChecks;
  const globalAuditLines = adversarial.globalFinancialAudits.map(
    ({ source, result }) =>
      `  ${source}: ${result.walletsChecked} Wallets, ${result.transactionsChecked} transactions, ${result.ledgerEntriesChecked} Ledger entries`,
  );
  const adversarialCheckCount =
    adversarial.globalFinancialAudits.length +
    adversarial.atomicFailurePoints.length +
    adversarial.sqsIdentityCases.length;
  const text = [
    "Acceptance Verification",
    "=======================",
    "",
    `Total command checks: ${report.summary.totalCommandChecks}`,
    `Passed: ${report.summary.passed}`,
    `Failed: ${report.summary.failed}`,
    `Warnings: ${report.summary.warnings}`,
    `Duration: ${(report.summary.durationMs / 1000).toFixed(1)} seconds`,
    "",
    "Regression tests executed:",
    ...regressionLines,
    "",
    "New adversarial checks:",
    `  Global financial audits: ${adversarial.globalFinancialAudits.length}`,
    `  Atomic failure points: ${adversarial.atomicFailurePoints.length}`,
    `  SQS identity/redelivery cases: ${adversarial.sqsIdentityCases.length}`,
    `  Total: ${adversarialCheckCount}`,
    "",
    "Global financial audit:",
    ...globalAuditLines,
    ...invariantLines,
    "",
    "Static audits:",
    ...adversarial.staticAudits.map((item) => `  ${item}`),
    "Infrastructure preflight:",
    ...adversarial.infrastructurePreflight.map((item) => `  ${item}`),
    "",
    `JSON report: ${path.join(outputDirectory, "acceptance-report.json")}`,
  ].join("\n");
  await writeFile(
    path.join(outputDirectory, "acceptance-report.txt"),
    `${text}\n`,
    "utf8",
  );
  process.stdout.write(`\n${text}\n`);
}

async function main(): Promise<void> {
  let admin: MikroORM | null = null;
  let sqs: SQSClient | null = null;
  let databaseName: string | null = null;
  let environment: ReturnType<typeof parseEnvironment> | null = null;
  let failed = false;
  try {
    const fingerprint = await fingerprintAndCreateTestDatabase();
    admin = fingerprint.admin;
    sqs = fingerprint.sqs;
    databaseName = fingerprint.databaseName;
    environment = fingerprint.environment;
    report.environment.testDatabaseIsolation =
      "Dedicated random database; child harnesses create/drop their own random databases within it";
    recordScenario("Environment fingerprint and isolated database", "PASS", 0, [
      `PostgreSQL: ${String(report.environment.postgresVersion)}`,
      "LocalStack: required queues reachable",
      `Temporary database: ${databaseName}`,
      "No configured development database is dropped",
    ]);
    report.executionBreakdown.adversarialChecks.infrastructurePreflight.push(
      "PostgreSQL version queried, all configured LocalStack queues resolved, and a random acceptance database created",
    );

    if (!(await runStaticAudits())) {
      failed = true;
      report.errors.push(
        "Static production safety audit found a potentially unsafe pattern",
      );
    }

    const childEnvironment = {
      ...process.env,
      POSTGRES_DB: databaseName,
      LOG_LEVEL: "silent",
      SQS_CONSUMER_ENABLED: "false",
      OUTBOX_PUBLISHER_ENABLED: "false",
    } as Record<string, string>;

    const suites: Array<{ name: string; args: string[]; timeout: number }> = [
      { name: "Unit suite", args: ["test"], timeout: 120_000 },
      {
        name: "PostgreSQL and LocalStack integration suite",
        args: ["run", "test:integration"],
        timeout: 240_000,
      },
      {
        name: "Independent-process distributed suite",
        args: ["run", "test:distributed"],
        timeout: 240_000,
      },
      {
        name: "Real HTTP load/correctness suite",
        args: ["run", "test:load"],
        timeout: 300_000,
      },
    ];

    for (const suite of suites) {
      if (failed) break;
      const result = await runCommand(
        suite.name,
        suite.args,
        childEnvironment,
        suite.timeout,
      );
      if (suite.name === "Independent-process distributed suite") {
        const parsed = recordJsonScenarios("Distributed", result.output);
        if (parsed === null) {
          const ok = result.exitCode === 0;
          recordScenario(
            suite.name,
            ok ? "PASS" : "FAIL",
            result.durationMs,
            ["Distributed runner completed"],
            ok ? undefined : "Distributed runner output could not be parsed",
          );
          if (!ok) failed = true;
        } else {
          const scenarios = parsed.scenarios as string[];
          report.executionBreakdown.regressionTests.distributed = {
            passed: scenarios.length,
            failed: 0,
            skipped: 0,
          };
          const commitDifferentIdentity = scenarios.find((name) =>
            name.includes(
              "distinct messageId converged through business idempotency",
            ),
          );
          if (commitDifferentIdentity !== undefined) {
            report.executionBreakdown.adversarialChecks.sqsIdentityCases.push({
              name: "C5 committed crash redelivery followed by a distinct transport messageId",
              result: "PASS",
            });
          }
          if (result.exitCode !== 0) failed = true;
        }
      } else if (suite.name === "Real HTTP load/correctness suite") {
        const parsed = recordLoadScenarios(result.output);
        if (!parsed || result.exitCode !== 0) {
          recordScenario(
            suite.name,
            "FAIL",
            result.durationMs,
            ["Load report or financial correctness validation failed"],
            `Exit code ${result.exitCode}`,
          );
          failed = true;
        } else {
          const loadResult = findStructuredJson(
            result.output,
            (candidate) =>
              typeof candidate.runtime === "object" &&
              Array.isArray(candidate.scenarios),
          );
          const loadScenarios = loadResult?.scenarios;
          report.executionBreakdown.regressionTests.load = {
            passed: Array.isArray(loadScenarios) ? loadScenarios.length : 0,
            failed: 0,
            skipped: 0,
          };
        }
      } else {
        const parsed = await recordSuiteTests(
          suite.name,
          result.output,
          result.exitCode,
          result.durationMs,
        );
        const category = suite.name === "Unit suite" ? "unit" : "integration";
        report.executionBreakdown.regressionTests[category] = {
          passed: parsed.passed.length,
          failed: parsed.failed.length,
          skipped: parsed.skipped.length,
        };
        if (category === "integration") {
          const auditLines = parseMarkedJson(
            result.output,
            "[GLOBAL_FINANCIAL_AUDIT]",
          );
          const audit = auditLines.find(isGlobalFinancialAuditResult);
          if (audit !== undefined) {
            recordGlobalFinancialAudit("integration database", audit);
          } else {
            failed = true;
            report.errors.push(
              "Integration suite did not emit its structured global financial audit result",
            );
          }

          const atomicPoints = parsed.passed
            .map((item) => item.name)
            .filter((name) =>
              name.startsWith(
                "PostgreSQL persistence > atomic failure injection ",
              ),
            );
          report.executionBreakdown.adversarialChecks.atomicFailurePoints.push(
            ...atomicPoints,
          );
          const identityChecks = parseMarkedJson(
            result.output,
            "[ACCEPTANCE_CHECK]",
          ).filter(
            (value): value is Record<string, unknown> =>
              value !== null && typeof value === "object" && "name" in value,
          );
          report.executionBreakdown.adversarialChecks.sqsIdentityCases.push(
            ...identityChecks,
          );
          const expectedIdentityNames = [
            "C1 different messageIds same idempotency key",
            "C2 concurrent different Idempotency-Keys same provider identity",
            "C3 divergent payload for provider identity sent to DLQ",
            "C4 concurrent SQS delivery",
          ];
          const actualIdentityNames = new Set(
            identityChecks.map((item) => String(item.name)),
          );
          if (
            expectedIdentityNames.some((name) => !actualIdentityNames.has(name))
          ) {
            failed = true;
            report.errors.push(
              "One or more structured SQS identity checks were missing from integration output",
            );
          }
          if (atomicPoints.length !== 6) {
            failed = true;
            report.errors.push(
              `Expected six atomic failure checkpoints, received ${atomicPoints.length}`,
            );
          }
        }
        if (result.exitCode !== 0) failed = true;
      }
    }
    const audits =
      report.executionBreakdown.adversarialChecks.globalFinancialAudits;
    if (audits.length !== 2) {
      failed = true;
      report.errors.push(
        `Expected structured global audits from integration and distributed databases, received ${audits.length}`,
      );
    }
    const distributedAudit = audits.find(
      (item) => item.source === "distributed database",
    )?.result;
    if (distributedAudit !== undefined) {
      report.financialInvariants = Object.fromEntries(
        Object.entries(distributedAudit.checks).map(([name, status]) => [
          name,
          status,
        ]),
      ) as Record<string, "PASS" | "NOT_VERIFIED">;
    }
    if (report.warnings.length > 0) {
      report.warnings.push(
        "Skipped unit-test cases are infrastructure-guarded; dedicated integration/distributed suites provide their real-service coverage.",
      );
    }
  } catch (error) {
    failed = true;
    const summary =
      error instanceof Error
        ? `${error.name}: ${error.message}`
        : "Unknown acceptance harness failure";
    report.errors.push(summary);
    recordScenario(
      "Acceptance harness setup",
      "FAIL",
      0,
      ["PostgreSQL/LocalStack preflight failed"],
      summary,
    );
  } finally {
    if (sqs !== null) sqs.destroy();
    if (admin !== null && databaseName !== null && environment !== null) {
      try {
        await admin.close(true);
        const cleanupAdmin = await MikroORM.init(databaseConfig(environment));
        try {
          await cleanupAdmin.em
            .getConnection()
            .execute(
              "select pg_terminate_backend(pid) from pg_stat_activity where datname = ? and pid <> pg_backend_pid()",
              [databaseName],
            );
          await cleanupAdmin.em
            .getConnection()
            .execute(`drop database "${databaseName}"`);
        } finally {
          await cleanupAdmin.close(true);
        }
      } catch (error) {
        failed = true;
        const summary =
          error instanceof Error
            ? error.message
            : "Temporary database cleanup failed";
        report.errors.push(summary);
        recordScenario(
          "Temporary database cleanup",
          "FAIL",
          0,
          ["Cleanup was limited to the acceptance-specific random database"],
          summary,
        );
      }
    } else if (admin !== null) {
      try {
        await admin.close(true);
      } catch {
        report.warnings.push(
          "PostgreSQL admin connection did not close cleanly",
        );
      }
    }
    try {
      await writeArtifacts();
    } catch (error) {
      failed = true;
      process.stderr.write(
        error instanceof Error
          ? `Could not write acceptance artifacts: ${error.message}\n`
          : "Could not write acceptance artifacts\n",
      );
    }
  }
  if (failed || report.summary.failed > 0) process.exitCode = 1;
}

main().catch(async (error: unknown) => {
  report.errors.push(
    error instanceof Error ? error.message : "Unknown fatal failure",
  );
  await writeArtifacts();
  process.exitCode = 1;
});
