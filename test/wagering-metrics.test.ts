import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Registry } from "prom-client";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { DriverException } from "@mikro-orm/core";
import { WageringMetrics } from "../src/infrastructure/metrics/wagering-metrics";
import { Money } from "../src/shared/domain/money";
import { Wallet } from "../src/wallet/domain/wallet";
import type { WagerTransaction } from "../src/wagering/domain/wager-transaction";
import {
  ProcessWagerTransaction,
  type WagerTransactionProcessingArtifacts,
  type WagerTransactionProcessingContext,
  type WagerTransactionProcessingStore,
} from "../src/wagering/application/process-wager-transaction";
import { WageringTransactionsController } from "../src/wagering/wagering-transactions.controller";
import { isPostgresConcurrencyConflict } from "../src/infrastructure/database/transient-postgres-failure";

class MetricsProcessingStore implements WagerTransactionProcessingStore {
  private transaction: WagerTransaction | null = null;
  private readonly wallet = Wallet.open({
    id: "metrics-wallet",
    playerId: "metrics-player",
    currency: "BRL",
    balance: Money.from({ amount: "100.00", currency: "BRL" }),
  });

  async executeIdempotently(
    _identity: {
      idempotencyKey: string;
      payloadHash: string;
      walletId: string;
      providerId: string;
      externalTransactionId: string;
    },
    createArtifacts: (
      context: WagerTransactionProcessingContext,
    ) => Promise<WagerTransactionProcessingArtifacts>,
  ) {
    if (this.transaction !== null) {
      return {
        transaction: this.transaction,
        idempotentReplay: true,
        inboxDuplicate: false,
        replaySource: "idempotency" as const,
      };
    }
    const artifacts = await createArtifacts({
      wallet: this.wallet,
      findReferenceTransaction: async () => null,
      hasProcessedReversal: async () => false,
    });
    this.transaction = artifacts.transaction;
    return {
      transaction: artifacts.transaction,
      idempotentReplay: false,
      inboxDuplicate: false,
      replaySource: null,
    };
  }
}

describe("wagering metrics", () => {
  let app: INestApplication;
  let baseUrl: string;
  let registry: Registry;
  let metrics: WageringMetrics;

  beforeAll(async () => {
    registry = new Registry();
    metrics = new WageringMetrics(registry);
    const processor = new ProcessWagerTransaction(
      new MetricsProcessingStore(),
      metrics,
    );
    const module = await Test.createTestingModule({
      controllers: [WageringTransactionsController],
      providers: [
        { provide: ProcessWagerTransaction, useValue: processor },
        { provide: WageringMetrics, useValue: metrics },
      ],
    }).compile();
    app = module.createNestApplication();
    await app.listen(0, "127.0.0.1");
    baseUrl = await app.getUrl();
  });

  afterAll(async () => {
    await app.close();
    registry.clear();
  });

  test("counts a persisted HTTP outcome, replay separately, and records latency", async () => {
    const body = {
      providerId: "metrics-provider",
      externalTransactionId: "metrics-external-id",
      playerId: "metrics-player",
      walletId: "metrics-wallet",
      roundId: "metrics-round",
      gameId: "metrics-game",
      kind: "BET",
      money: { amount: "10.00", currency: "BRL" },
    };
    const post = () =>
      fetch(`${baseUrl}/wagering/transactions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "metrics-key",
        },
        body: JSON.stringify(body),
      });

    expect((await post()).status).toBe(201);
    expect((await post()).status).toBe(200);

    const exposition = await registry.metrics();
    expect(exposition).toContain(
      'wagering_transactions_total{status="PROCESSED",kind="BET",transport="http"} 1',
    );
    expect(exposition).toContain(
      'wagering_duplicates_total{source="idempotency"} 1',
    );
    expect(exposition).toContain(
      'wagering_processing_duration_seconds_count{transport="http",outcome="processed"} 1',
    );
    expect(exposition).toContain(
      'wagering_processing_duration_seconds_count{transport="http",outcome="replay"} 1',
    );
  });

  test("exposes bounded operational counters and clamps outbox lag at zero", async () => {
    metrics.recordDuplicate("inbox");
    metrics.recordRetry("sqs_consumer");
    metrics.recordDlq("invalid_message");
    metrics.recordLockConflict("wager_processing");
    metrics.recordOutboxPublish("failure");
    metrics.setOutboxLag(-1);
    metrics.recordReconciliationMismatch();
    metrics.recordSqsMessage("handled");
    metrics.recordReferenceRecovery("attempt");

    const exposition = await registry.metrics();
    expect(exposition).toContain('wagering_duplicates_total{source="inbox"} 1');
    expect(exposition).toContain(
      'wagering_retries_total{component="sqs_consumer"} 1',
    );
    expect(exposition).toContain(
      'wagering_dlq_messages_total{reason="invalid_message"} 1',
    );
    expect(exposition).toContain(
      'wagering_lock_conflicts_total{operation="wager_processing"} 1',
    );
    expect(exposition).toContain(
      'wagering_outbox_publish_total{outcome="failure"} 1',
    );
    expect(exposition).toContain("wagering_outbox_lag_seconds 0");
    expect(exposition).toContain("wagering_reconciliation_mismatches_total 1");
    expect(exposition).toContain(
      'wagering_sqs_messages_total{outcome="handled"} 1',
    );
    expect(exposition).toContain(
      'wagering_reference_recovery_total{outcome="attempt"} 1',
    );
  });

  test("classifies only PostgreSQL concurrency SQLSTATEs as lock conflicts", () => {
    const deadlock = new DriverException(
      Object.assign(new Error("Deadlock detected"), { code: "40P01" }),
    );
    const lockTimeout = new DriverException(
      Object.assign(new Error("Lock unavailable"), { code: "55P03" }),
    );
    const serializationFailure = new DriverException(
      Object.assign(new Error("Serialization failure"), { code: "40001" }),
    );
    const businessConstraint = new DriverException(
      Object.assign(new Error("Business constraint"), { code: "23514" }),
    );

    expect(isPostgresConcurrencyConflict(deadlock)).toBe(true);
    expect(isPostgresConcurrencyConflict(lockTimeout)).toBe(true);
    expect(isPostgresConcurrencyConflict(serializationFailure)).toBe(true);
    expect(isPostgresConcurrencyConflict(businessConstraint)).toBe(false);
  });
});
