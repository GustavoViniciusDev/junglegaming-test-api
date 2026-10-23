import "reflect-metadata";
import { test, expect } from "bun:test";
import { SQSClient } from "@aws-sdk/client-sqs";
import { MikroORM } from "@mikro-orm/postgresql";
import { Test } from "@nestjs/testing";
import { PinoLogger } from "nestjs-pino";
import { Registry } from "prom-client";
import { HealthController } from "../src/health/health.controller";
import { ENVIRONMENT } from "../src/infrastructure/config/config.module";
import { MetricsController } from "../src/infrastructure/metrics/metrics.module";
import { WageringMetrics } from "../src/infrastructure/metrics/wagering-metrics";
import { setupSwagger } from "../src/infrastructure/http/swagger";
import { ProcessWagerTransaction } from "../src/wagering/application/process-wager-transaction";
import { ReadWagerTransaction } from "../src/wagering/application/read-wager-transaction";
import {
  ProviderWagerTransactionReadsController,
  WagerTransactionReadsController,
} from "../src/wagering/wager-transaction-reads.controller";
import { WageringTransactionsController } from "../src/wagering/wagering-transactions.controller";
import { CreateWallet } from "../src/wallet/application/create-wallet";
import {
  ReadWallet,
  ReadWalletLedger,
} from "../src/wallet/application/read-wallet";
import { ReconcileWallet } from "../src/wallet/application/reconcile-wallet";
import { WalletReconciliationController } from "../src/wallet/wallet-reconciliation.controller";
import { WalletsController } from "../src/wallet/wallets.controller";

test("Swagger documentation endpoints expose routes and string money schemas", async () => {
  const registry = new Registry();
  const moduleRef = await Test.createTestingModule({
    controllers: [
      WalletsController,
      WalletReconciliationController,
      WageringTransactionsController,
      WagerTransactionReadsController,
      ProviderWagerTransactionReadsController,
      HealthController,
      MetricsController,
    ],
    providers: [
      { provide: CreateWallet, useValue: {} },
      { provide: ReadWallet, useValue: {} },
      { provide: ReadWalletLedger, useValue: {} },
      { provide: ReconcileWallet, useValue: {} },
      { provide: ProcessWagerTransaction, useValue: {} },
      { provide: ReadWagerTransaction, useValue: {} },
      { provide: WageringMetrics, useValue: {} },
      { provide: PinoLogger, useValue: { warn() {}, info() {} } },
      { provide: MikroORM, useValue: {} },
      { provide: SQSClient, useValue: {} },
      { provide: ENVIRONMENT, useValue: { DEPENDENCY_TIMEOUT_MS: 100 } },
      { provide: Registry, useValue: registry },
    ],
  }).compile();
  const app = moduleRef.createNestApplication();
  setupSwagger(app);

  await app.listen(0, "127.0.0.1");
  try {
    const address = app.getHttpServer().address() as { port: number };
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const [uiResponse, jsonResponse] = await Promise.all([
      fetch(`${baseUrl}/docs`),
      fetch(`${baseUrl}/docs-json`),
    ]);
    expect(uiResponse.status).toBe(200);
    expect(jsonResponse.status).toBe(200);
    const document = (await jsonResponse.json()) as {
      openapi: string;
      info: { title: string; version: string };
      paths: Record<string, unknown>;
      components: {
        schemas: Record<
          string,
          { properties?: Record<string, { type?: string; $ref?: string }> }
        >;
      };
    };
    expect(document.openapi).toStartWith("3.");
    expect(document.info.title).toBe("Jungle Gaming Wagering API");
    expect(document.info.version).toBe("1.0.0");
    for (const path of [
      "/wallets",
      "/wallets/{walletId}",
      "/wallets/{walletId}/ledger",
      "/wallets/{walletId}/reconciliation",
      "/wagering/transactions",
      "/wagering/transactions/{transactionId}",
      "/providers/{providerId}/wagering/transactions/{externalTransactionId}",
      "/health/live",
      "/health/ready",
      "/metrics",
    ]) {
      expect(document.paths[path]).toBeDefined();
    }
    const schemas = document.components.schemas;
    expect(schemas.MoneySchema?.properties?.amount?.type).toBe("string");
    expect(schemas.SignedMoneySchema?.properties?.amount?.type).toBe("string");
    expect(
      schemas.WalletCreateRequestSchema?.properties?.initialBalance?.type,
    ).toBe("string");
    expect(
      schemas.WagerTransactionRequestSchema?.properties?.money?.$ref,
    ).toContain("MoneySchema");
    const transactionPost = document.paths["/wagering/transactions"] as {
      post?: {
        parameters?: Array<{
          name: string;
          in: string;
          required?: boolean;
          description?: string;
        }>;
      };
    };
    const idempotencyHeader = transactionPost.post?.parameters?.find(
      (parameter) => parameter.name.toLowerCase() === "idempotency-key",
    );
    expect(idempotencyHeader?.in).toBe("header");
    expect(idempotencyHeader?.required).toBe(true);
    expect(idempotencyHeader?.description).toContain("same business payload");
    const ledgerGet = document.paths["/wallets/{walletId}/ledger"] as {
      get?: { tags?: string[] };
    };
    expect(ledgerGet.get?.tags).toEqual(["Ledger"]);
  } finally {
    await app.close();
  }
});
