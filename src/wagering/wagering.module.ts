import { Module } from "@nestjs/common";
import { ENVIRONMENT } from "../infrastructure/config/config.module";
import type { Environment } from "../infrastructure/config/environment";
import { DatabaseModule } from "../infrastructure/database/database.module";
import { MetricsModule } from "../infrastructure/metrics/metrics.module";
import { WageringMetrics } from "../infrastructure/metrics/wagering-metrics";
import { PinoLogger } from "nestjs-pino";
import { SqsModule } from "../infrastructure/sqs/sqs.module";
import { LoggingModule } from "../infrastructure/logging/logging.module";
import { ProcessWagerTransaction } from "./application/process-wager-transaction";
import { RecoverPendingReferences } from "./application/recover-pending-references";
import { MikroOrmWagerTransactionProcessingStore } from "./infrastructure/mikro-orm-wager-transaction-processing-store";
import { PendingReferenceRecoveryScheduler } from "./infrastructure/pending-reference-recovery-scheduler";
import { WageringTransactionsController } from "./wagering-transactions.controller";
import { WagerTransactionSqsConsumer } from "./infrastructure/wager-transaction-sqs-consumer";
import { PublishOutboxMessages } from "../outbox/application/publish-outbox-messages";
import { MikroOrmOutboxPublishingStore } from "../outbox/infrastructure/mikro-orm-outbox-publishing-store";
import { AwsSqsIntegrationEventQueue } from "../outbox/infrastructure/aws-sqs-integration-event-queue";
import { OutboxPublisherScheduler } from "../outbox/infrastructure/outbox-publisher-scheduler";
import { ReadWagerTransaction } from "./application/read-wager-transaction";
import { MikroOrmWagerTransactionReadStore } from "./infrastructure/mikro-orm-wager-transaction-read-store";
import {
  ProviderWagerTransactionReadsController,
  WagerTransactionReadsController,
} from "./wager-transaction-reads.controller";

@Module({
  imports: [DatabaseModule, SqsModule, LoggingModule, MetricsModule],
  controllers: [
    WageringTransactionsController,
    WagerTransactionReadsController,
    ProviderWagerTransactionReadsController,
  ],
  providers: [
    MikroOrmWagerTransactionProcessingStore,
    {
      provide: ProcessWagerTransaction,
      inject: [MikroOrmWagerTransactionProcessingStore, WageringMetrics],
      useFactory: (
        store: MikroOrmWagerTransactionProcessingStore,
        metrics: WageringMetrics,
      ) => new ProcessWagerTransaction(store, metrics),
    },
    {
      provide: RecoverPendingReferences,
      inject: [
        MikroOrmWagerTransactionProcessingStore,
        ProcessWagerTransaction,
        ENVIRONMENT,
        WageringMetrics,
        PinoLogger,
      ],
      useFactory: (
        store: MikroOrmWagerTransactionProcessingStore,
        processor: ProcessWagerTransaction,
        environment: Environment,
        metrics: WageringMetrics,
        logger: PinoLogger,
      ) =>
        new RecoverPendingReferences(
          store,
          processor,
          {
            baseDelayMs: environment.REFERENCE_RETRY_BASE_DELAY_MS,
            maxAttempts: environment.REFERENCE_RETRY_MAX_ATTEMPTS,
            batchSize: environment.REFERENCE_RETRY_BATCH_SIZE,
          },
          metrics,
          logger,
        ),
    },
    PendingReferenceRecoveryScheduler,
    WagerTransactionSqsConsumer,
    MikroOrmOutboxPublishingStore,
    AwsSqsIntegrationEventQueue,
    {
      provide: PublishOutboxMessages,
      inject: [
        MikroOrmOutboxPublishingStore,
        AwsSqsIntegrationEventQueue,
        ENVIRONMENT,
        WageringMetrics,
      ],
      useFactory: (
        store: MikroOrmOutboxPublishingStore,
        queue: AwsSqsIntegrationEventQueue,
        environment: Environment,
        metrics: WageringMetrics,
      ) =>
        new PublishOutboxMessages(
          store,
          queue,
          {
            batchSize: environment.OUTBOX_PUBLISHER_BATCH_SIZE,
            baseDelayMs: environment.OUTBOX_PUBLISHER_RETRY_BASE_DELAY_MS,
            maxDelayMs: environment.OUTBOX_PUBLISHER_RETRY_MAX_DELAY_MS,
          },
          metrics,
        ),
    },
    OutboxPublisherScheduler,
    MikroOrmWagerTransactionReadStore,
    {
      provide: ReadWagerTransaction,
      inject: [MikroOrmWagerTransactionReadStore],
      useFactory: (store: MikroOrmWagerTransactionReadStore) =>
        new ReadWagerTransaction(store),
    },
  ],
  exports: [ProcessWagerTransaction],
})
export class WageringModule {}
