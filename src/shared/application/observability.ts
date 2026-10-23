export type WageringTransport = "http" | "sqs";

export type TransactionMetricOutcome =
  | "processed"
  | "rejected"
  | "pending_reference"
  | "failed"
  | "replay"
  | "conflict"
  | "error";

export interface WageringMetricsPort {
  recordTransaction(
    status: string,
    kind: string,
    transport: WageringTransport,
  ): void;
  recordDuplicate(source: "idempotency" | "provider_identity" | "inbox"): void;
  recordRetry(
    component: "reference_recovery" | "outbox_publish" | "sqs_consumer",
  ): void;
  recordDlq(reason: "invalid_message" | "identity_conflict"): void;
  recordLockConflict(
    operation: "wager_processing" | "reference_recovery",
  ): void;
  setOutboxLag(seconds: number): void;
  recordOutboxPublish(outcome: "success" | "failure"): void;
  observeProcessing(
    transport: WageringTransport,
    outcome: TransactionMetricOutcome,
    durationSeconds: number,
  ): void;
  recordReconciliationMismatch(): void;
  recordSqsMessage(outcome: "handled" | "failure"): void;
  recordReferenceRecovery(
    outcome: "attempt" | "processed" | "rejected" | "exhausted",
  ): void;
}
