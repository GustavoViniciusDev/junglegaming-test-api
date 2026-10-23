import type {
  WagerTransactionProcessingArtifacts,
  WagerTransactionProcessingContext,
} from "./process-wager-transaction";
import type { ProcessWagerTransaction } from "./process-wager-transaction";
import {
  defaultReferenceRetryPolicy,
  type ReferenceRetryPolicyOptions,
} from "./reference-retry-policy";
import type { WagerTransaction } from "../domain/wager-transaction";
import type { WageringMetricsPort } from "../../shared/application/observability";

export interface PendingReferenceRecoveryStore {
  recoverDue(
    options: ReferenceRetryPolicyOptions & { now: Date },
    resume: (
      transaction: WagerTransaction,
      context: WagerTransactionProcessingContext,
      nextAttempt: number,
    ) => Promise<WagerTransactionProcessingArtifacts | null>,
  ): Promise<number>;
}

export interface PendingReferenceRecoveryLogger {
  debug(
    context: {
      transactionId: string;
      walletId: string;
      providerId: string | null;
      attempt: number;
    },
    message: string,
  ): void;
}

export class RecoverPendingReferences {
  constructor(
    private readonly store: PendingReferenceRecoveryStore,
    private readonly processor: ProcessWagerTransaction,
    private readonly policy: ReferenceRetryPolicyOptions = defaultReferenceRetryPolicy,
    private readonly metrics?: WageringMetricsPort,
    private readonly logger?: PendingReferenceRecoveryLogger,
  ) {}

  runBatch(now: Date = new Date()): Promise<number> {
    return this.store.recoverDue(
      { ...this.policy, now },
      async (transaction, context, nextAttempt) => {
        this.metrics?.recordRetry("reference_recovery");
        this.metrics?.recordReferenceRecovery("attempt");
        this.logger?.debug(
          {
            transactionId: transaction.id,
            walletId: transaction.walletId,
            providerId: transaction.providerId,
            attempt: nextAttempt,
          },
          "Pending reference recovery started",
        );
        return this.processor.resumePendingReference(
          transaction,
          context,
          now,
          nextAttempt,
          this.policy.maxAttempts,
        );
      },
    );
  }
}
