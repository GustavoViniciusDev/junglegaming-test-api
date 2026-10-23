import type { IntegrationEventJSON } from "../../shared/domain/integration-event";
import type { OutboxRetryPolicy } from "./outbox-retry-policy";
import type { WageringMetricsPort } from "../../shared/application/observability";

export interface OutboxPublishOutcome {
  id: string;
  aggregateId: string;
  eventType: string;
  attempts: number;
  published: boolean;
  errorType?: string;
}

export interface OutboxPublishBatch {
  outcomes: OutboxPublishOutcome[];
}

export interface OutboxPublishingStore {
  publishDueMessages(input: {
    now: Date;
    batchSize: number;
    retry: OutboxRetryPolicy;
    publish: (event: IntegrationEventJSON) => Promise<void>;
  }): Promise<OutboxPublishBatch>;
  findOldestUnpublishedOccurredAt?(): Promise<Date | null>;
}

export interface IntegrationEventQueue {
  publish(event: IntegrationEventJSON): Promise<void>;
}

export interface OutboxPublisherOptions extends OutboxRetryPolicy {
  batchSize: number;
}

export class PublishOutboxMessages {
  constructor(
    private readonly store: OutboxPublishingStore,
    private readonly queue: IntegrationEventQueue,
    private readonly options: OutboxPublisherOptions,
    private readonly metrics?: WageringMetricsPort,
  ) {}

  async runBatch(now = new Date()): Promise<OutboxPublishBatch> {
    await this.updateLagMetric(now);
    const batch = await this.store.publishDueMessages({
      now: new Date(now.getTime()),
      batchSize: this.options.batchSize,
      retry: {
        baseDelayMs: this.options.baseDelayMs,
        maxDelayMs: this.options.maxDelayMs,
      },
      publish: (event) => this.queue.publish(event),
    });
    for (const outcome of batch.outcomes) {
      this.metrics?.recordOutboxPublish(
        outcome.published ? "success" : "failure",
      );
      if (!outcome.published) this.metrics?.recordRetry("outbox_publish");
    }
    return batch;
  }

  private async updateLagMetric(now: Date): Promise<void> {
    if (this.store.findOldestUnpublishedOccurredAt === undefined) return;
    try {
      const oldest = await this.store.findOldestUnpublishedOccurredAt();
      this.metrics?.setOutboxLag(
        oldest === null ? 0 : (now.getTime() - oldest.getTime()) / 1000,
      );
    } catch {
      // Metrics collection must not change the publishing result.
    }
  }
}
