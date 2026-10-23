import {
  Inject,
  Injectable,
  type OnApplicationBootstrap,
  type BeforeApplicationShutdown,
} from "@nestjs/common";
import { PinoLogger } from "nestjs-pino";
import { ENVIRONMENT } from "../../infrastructure/config/config.module";
import type { Environment } from "../../infrastructure/config/environment";
import { PublishOutboxMessages } from "../application/publish-outbox-messages";

@Injectable()
export class OutboxPublisherScheduler
  implements OnApplicationBootstrap, BeforeApplicationShutdown
{
  private stopping = false;
  private interval: ReturnType<typeof setInterval> | null = null;
  private activeBatch: Promise<void> | null = null;

  constructor(
    @Inject(PublishOutboxMessages)
    private readonly publisher: PublishOutboxMessages,
    @Inject(ENVIRONMENT) private readonly environment: Environment,
    @Inject(PinoLogger) private readonly logger: PinoLogger,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.environment.OUTBOX_PUBLISHER_ENABLED) return;
    this.interval = setInterval(
      () => void this.runOnce(),
      this.environment.OUTBOX_PUBLISHER_POLL_INTERVAL_MS,
    );
    void this.runOnce();
  }

  async beforeApplicationShutdown(): Promise<void> {
    this.stopping = true;
    if (this.interval !== null) clearInterval(this.interval);
    if (this.activeBatch === null) return;

    let timeout: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      this.activeBatch,
      new Promise<void>((resolve) => {
        timeout = setTimeout(
          resolve,
          this.environment.OUTBOX_PUBLISHER_SHUTDOWN_TIMEOUT_MS,
        );
      }),
    ]);
    if (timeout !== undefined) clearTimeout(timeout);
  }

  async runOnce(now = new Date()): Promise<void> {
    if (this.stopping || this.activeBatch !== null) return;
    const batch = this.publish(now);
    this.activeBatch = batch;
    try {
      await batch;
    } finally {
      if (this.activeBatch === batch) this.activeBatch = null;
    }
  }

  private async publish(now: Date): Promise<void> {
    try {
      const batch = await this.publisher.runBatch(now);
      for (const outcome of batch.outcomes) {
        const context = {
          outboxMessageId: outcome.id,
          eventId: outcome.id,
          aggregateId: outcome.aggregateId,
          eventType: outcome.eventType,
          attempts: outcome.attempts,
        };
        if (outcome.published) {
          this.logger.info(context, "Outbox event published");
        } else {
          this.logger.warn(
            { ...context, errorType: outcome.errorType },
            "Outbox event publication failed and was scheduled for retry",
          );
        }
      }
    } catch (error) {
      this.logger.error(
        { errorType: error instanceof Error ? error.name : "UnknownError" },
        "Outbox publisher batch failed",
      );
    }
  }
}
