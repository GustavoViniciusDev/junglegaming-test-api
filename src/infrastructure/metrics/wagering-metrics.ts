import { Counter, Gauge, Histogram, Registry } from "prom-client";
import { Inject, Injectable } from "@nestjs/common";
import type {
  TransactionMetricOutcome,
  WageringMetricsPort,
  WageringTransport,
} from "../../shared/application/observability";

@Injectable()
export class WageringMetrics implements WageringMetricsPort {
  private readonly transactions: Counter<"status" | "kind" | "transport">;
  private readonly duplicates: Counter<"source">;
  private readonly retries: Counter<"component">;
  private readonly deadLetterMessages: Counter<"reason">;
  private readonly lockConflicts: Counter<"operation">;
  private readonly outboxLag: Gauge<string>;
  private readonly outboxPublishes: Counter<"outcome">;
  private readonly processingDuration: Histogram<"transport" | "outcome">;
  private readonly reconciliationMismatches: Counter<string>;
  private readonly sqsMessages: Counter<"outcome">;
  private readonly referenceRecovery: Counter<"outcome">;

  constructor(@Inject(Registry) registry: Registry) {
    this.transactions = new Counter({
      name: "wagering_transactions_total",
      help: "New persisted wager transactions by final or initial outcome",
      labelNames: ["status", "kind", "transport"],
      registers: [registry],
    });
    this.duplicates = new Counter({
      name: "wagering_duplicates_total",
      help: "Safely deduplicated requests or messages",
      labelNames: ["source"],
      registers: [registry],
    });
    this.retries = new Counter({
      name: "wagering_retries_total",
      help: "Operational retries performed by a subsystem",
      labelNames: ["component"],
      registers: [registry],
    });
    this.deadLetterMessages = new Counter({
      name: "wagering_dlq_messages_total",
      help: "Messages successfully sent to the dead-letter queue",
      labelNames: ["reason"],
      registers: [registry],
    });
    this.lockConflicts = new Counter({
      name: "wagering_lock_conflicts_total",
      help: "PostgreSQL deadlock, lock timeout, and serialization errors",
      labelNames: ["operation"],
      registers: [registry],
    });
    this.outboxLag = new Gauge({
      name: "wagering_outbox_lag_seconds",
      help: "Age of the oldest unpublished outbox event, regardless of retry eligibility",
      registers: [registry],
    });
    this.outboxLag.set(0);
    this.outboxPublishes = new Counter({
      name: "wagering_outbox_publish_total",
      help: "Outbox publish attempts by outcome",
      labelNames: ["outcome"],
      registers: [registry],
    });
    this.processingDuration = new Histogram({
      name: "wagering_processing_duration_seconds",
      help: "Wager transaction request processing duration",
      labelNames: ["transport", "outcome"],
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
      registers: [registry],
    });
    this.reconciliationMismatches = new Counter({
      name: "wagering_reconciliation_mismatches_total",
      help: "Wallet reconciliations that detected a mismatch",
      registers: [registry],
    });
    this.sqsMessages = new Counter({
      name: "wagering_sqs_messages_total",
      help: "SQS message handling outcomes",
      labelNames: ["outcome"],
      registers: [registry],
    });
    this.referenceRecovery = new Counter({
      name: "wagering_reference_recovery_total",
      help: "Pending reference recovery outcomes",
      labelNames: ["outcome"],
      registers: [registry],
    });
  }

  recordTransaction(
    status: string,
    kind: string,
    transport: WageringTransport,
  ): void {
    this.transactions.inc({ status, kind, transport });
  }

  recordDuplicate(source: "idempotency" | "provider_identity" | "inbox"): void {
    this.duplicates.inc({ source });
  }

  recordRetry(
    component: "reference_recovery" | "outbox_publish" | "sqs_consumer",
  ): void {
    this.retries.inc({ component });
  }

  recordDlq(reason: "invalid_message" | "identity_conflict"): void {
    this.deadLetterMessages.inc({ reason });
  }

  recordLockConflict(
    operation: "wager_processing" | "reference_recovery",
  ): void {
    this.lockConflicts.inc({ operation });
  }

  setOutboxLag(seconds: number): void {
    this.outboxLag.set(Math.max(0, seconds));
  }

  recordOutboxPublish(outcome: "success" | "failure"): void {
    this.outboxPublishes.inc({ outcome });
  }

  observeProcessing(
    transport: WageringTransport,
    outcome: TransactionMetricOutcome,
    durationSeconds: number,
  ): void {
    this.processingDuration.observe(
      { transport, outcome },
      Math.max(0, durationSeconds),
    );
  }

  recordReconciliationMismatch(): void {
    this.reconciliationMismatches.inc();
  }

  recordSqsMessage(outcome: "handled" | "failure"): void {
    this.sqsMessages.inc({ outcome });
  }

  recordReferenceRecovery(
    outcome: "attempt" | "processed" | "rejected" | "exhausted",
  ): void {
    this.referenceRecovery.inc({ outcome });
  }
}
