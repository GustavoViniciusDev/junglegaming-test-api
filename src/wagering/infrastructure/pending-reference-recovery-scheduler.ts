import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from "@nestjs/common";
import { RecoverPendingReferences } from "../application/recover-pending-references";
import type { Environment } from "../../infrastructure/config/environment";
import { ENVIRONMENT } from "../../infrastructure/config/config.module";

@Injectable()
export class PendingReferenceRecoveryScheduler
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PendingReferenceRecoveryScheduler.name);
  private interval: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(
    @Inject(RecoverPendingReferences)
    private readonly recovery: RecoverPendingReferences,
    @Inject(ENVIRONMENT) private readonly environment: Environment,
  ) {}

  onModuleInit(): void {
    this.interval = setInterval(
      () => void this.runOnce(),
      this.environment.REFERENCE_RETRY_POLL_INTERVAL_MS,
    );
    void this.runOnce();
  }

  onModuleDestroy(): void {
    if (this.interval !== null) clearInterval(this.interval);
  }

  private async runOnce(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.recovery.runBatch();
    } catch (error) {
      this.logger.error(
        "Pending reference recovery batch failed",
        error instanceof Error ? error.stack : String(error),
      );
    } finally {
      this.running = false;
    }
  }
}
