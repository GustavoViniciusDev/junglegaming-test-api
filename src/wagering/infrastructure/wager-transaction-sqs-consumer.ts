import {
  DeleteMessageCommand,
  GetQueueUrlCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
  type Message,
} from "@aws-sdk/client-sqs";
import {
  Inject,
  Injectable,
  type OnApplicationBootstrap,
  type BeforeApplicationShutdown,
} from "@nestjs/common";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { PinoLogger } from "nestjs-pino";
import { Optional } from "@nestjs/common";
import { WageringMetrics } from "../../infrastructure/metrics/wagering-metrics";
import type { TransactionMetricOutcome } from "../../shared/application/observability";
import { InvalidMoneyError } from "../../shared/domain/money";
import { InvalidWalletOperationError } from "../../wallet/domain/wallet";
import { ENVIRONMENT } from "../../infrastructure/config/config.module";
import type { Environment } from "../../infrastructure/config/environment";
import { InfrastructureUnavailableError } from "../../shared/application/infrastructure-unavailable-error";
import {
  IdempotencyConflictError,
  InboxMessageConflictError,
  InvalidWagerProcessingRequestError,
  ProcessWagerTransaction,
  ProviderTransactionConflictError,
  UnsupportedWagerTransactionKindError,
  WagerCurrencyMismatchError,
  WagerPlayerMismatchError,
  WagerWalletNotFoundError,
} from "../application/process-wager-transaction";
import { InvalidWagerTransactionStateError } from "../domain/wager-transaction";
import {
  parseWagerTransactionRequested,
  PermanentWagerMessageError,
} from "../application/wager-transaction-requested";

export const WAGER_TRANSACTION_CONSUMER_NAME = "wager-transaction-consumer.v1";

function isPermanentMessageError(error: unknown): error is Error {
  return (
    error instanceof PermanentWagerMessageError ||
    error instanceof InvalidWagerProcessingRequestError ||
    error instanceof UnsupportedWagerTransactionKindError ||
    error instanceof InvalidMoneyError ||
    error instanceof InvalidWalletOperationError ||
    error instanceof InvalidWagerTransactionStateError ||
    error instanceof IdempotencyConflictError ||
    error instanceof ProviderTransactionConflictError ||
    error instanceof InboxMessageConflictError ||
    error instanceof WagerWalletNotFoundError ||
    error instanceof WagerPlayerMismatchError ||
    error instanceof WagerCurrencyMismatchError
  );
}

@Injectable()
export class WagerTransactionSqsConsumer
  implements OnApplicationBootstrap, BeforeApplicationShutdown
{
  private stopping = false;
  private loop: Promise<void> | null = null;
  private receiveAbortController: AbortController | null = null;
  private mainQueueUrl: string | null = null;
  private deadLetterQueueUrl: string | null = null;

  constructor(
    @Inject(SQSClient) private readonly sqs: SQSClient,
    @Inject(ProcessWagerTransaction)
    private readonly processor: ProcessWagerTransaction,
    @Inject(ENVIRONMENT) private readonly environment: Environment,
    @Inject(PinoLogger) private readonly logger: PinoLogger,
    @Optional()
    @Inject(WageringMetrics)
    private readonly metrics?: WageringMetrics,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.environment.SQS_CONSUMER_ENABLED) return;
    this.loop = this.run();
  }

  async beforeApplicationShutdown(): Promise<void> {
    this.stopping = true;
    this.receiveAbortController?.abort();
    if (this.loop === null) return;

    let timeout: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      this.loop,
      new Promise<void>((resolve) => {
        timeout = setTimeout(
          resolve,
          this.environment.SQS_CONSUMER_SHUTDOWN_TIMEOUT_MS,
        );
      }),
    ]);
    if (timeout !== undefined) clearTimeout(timeout);
  }

  private async run(): Promise<void> {
    while (!this.stopping) {
      try {
        await this.pollOnce();
      } catch (error) {
        this.logger.warn(
          { errorType: error instanceof Error ? error.name : "UnknownError" },
          "Wager transaction queue polling failed",
        );
        await this.delay(500);
      }
    }
  }

  async pollOnce(): Promise<void> {
    const queueUrl = await this.getMainQueueUrl();
    const controller = new AbortController();
    this.receiveAbortController = controller;
    let messages: Message[];
    try {
      const response = await this.sqs.send(
        new ReceiveMessageCommand({
          QueueUrl: queueUrl,
          MaxNumberOfMessages: this.environment.SQS_CONSUMER_MAX_MESSAGES,
          WaitTimeSeconds: this.environment.SQS_CONSUMER_WAIT_TIME_SECONDS,
          VisibilityTimeout:
            this.environment.SQS_CONSUMER_VISIBILITY_TIMEOUT_SECONDS,
          MessageSystemAttributeNames: ["ApproximateReceiveCount"],
        }),
        { abortSignal: controller.signal },
      );
      messages = response.Messages ?? [];
    } finally {
      if (this.receiveAbortController === controller) {
        this.receiveAbortController = null;
      }
    }

    for (const message of messages) {
      if (this.stopping) break;
      await this.handleMessage(message);
    }
  }

  private async handleMessage(message: Message): Promise<void> {
    const startedAt = performance.now();
    let outcome: TransactionMetricOutcome = "error";
    let logContext: {
      messageId?: string | undefined;
      transactionId?: string | undefined;
      walletId?: string | undefined;
      providerId?: string | undefined;
    } = { messageId: message.MessageId };
    try {
      const receiveCount = Number(
        message.Attributes?.ApproximateReceiveCount ?? "1",
      );
      if (receiveCount > 1) this.metrics?.recordRetry("sqs_consumer");
      const envelope = parseWagerTransactionRequested(message.Body);
      logContext = {
        messageId: envelope.messageId,
        walletId: envelope.data.walletId,
        providerId: envelope.data.providerId,
      };
      const payloadHash = createHash("sha256")
        .update(message.Body ?? "", "utf8")
        .digest("hex");
      const processing = await this.processor.executeFromInbox(envelope.data, {
        consumerName: WAGER_TRANSACTION_CONSUMER_NAME,
        messageId: envelope.messageId,
        payloadHash,
        receivedAt: new Date(),
      });
      logContext.transactionId = processing.result.transactionId;
      this.logger.info(
        {
          ...logContext,
          replay: processing.result.idempotentReplay,
          inboxDuplicate: processing.inboxDuplicate,
        },
        "Wager transaction message committed",
      );
      outcome = processing.result.idempotentReplay
        ? "replay"
        : (processing.result.status.toLowerCase() as TransactionMetricOutcome);
      this.metrics?.recordSqsMessage("handled");
      await this.deleteMessage(message);
    } catch (error) {
      if (isPermanentMessageError(error)) {
        try {
          await this.sendToDeadLetterQueue(message);
          const reason =
            error instanceof IdempotencyConflictError ||
            error instanceof ProviderTransactionConflictError ||
            error instanceof InboxMessageConflictError
              ? "identity_conflict"
              : "invalid_message";
          this.metrics?.recordDlq(reason);
          await this.deleteMessage(message);
          this.metrics?.recordSqsMessage("failure");
          outcome = reason === "identity_conflict" ? "conflict" : "error";
          this.logger.warn(
            { ...logContext, errorType: error.name },
            "Permanent wager transaction message moved to the dead-letter queue",
          );
        } catch (transportError) {
          this.metrics?.recordSqsMessage("failure");
          this.logger.warn(
            {
              ...logContext,
              errorType:
                transportError instanceof Error
                  ? transportError.name
                  : "UnknownError",
            },
            "Wager transaction message could not be moved to the dead-letter queue",
          );
        }
        return;
      }

      this.metrics?.recordSqsMessage("failure");
      this.logger.error(
        {
          ...logContext,
          errorType: error instanceof Error ? error.name : "UnknownError",
          transient: error instanceof InfrastructureUnavailableError,
        },
        "Wager transaction message was not acknowledged",
      );
    } finally {
      this.metrics?.observeProcessing(
        "sqs",
        outcome,
        (performance.now() - startedAt) / 1000,
      );
    }
  }

  private async getMainQueueUrl(): Promise<string> {
    if (this.mainQueueUrl !== null) return this.mainQueueUrl;
    const response = await this.sqs.send(
      new GetQueueUrlCommand({
        QueueName: this.environment.SQS_WAGER_TRANSACTION_QUEUE_NAME,
      }),
    );
    if (response.QueueUrl === undefined) {
      throw new Error("Wager transaction queue URL was not returned");
    }
    this.mainQueueUrl = response.QueueUrl;
    return response.QueueUrl;
  }

  private async getDeadLetterQueueUrl(): Promise<string> {
    if (this.deadLetterQueueUrl !== null) return this.deadLetterQueueUrl;
    const response = await this.sqs.send(
      new GetQueueUrlCommand({
        QueueName: this.environment.SQS_WAGER_TRANSACTION_DLQ_NAME,
      }),
    );
    if (response.QueueUrl === undefined) {
      throw new Error(
        "Wager transaction dead-letter queue URL was not returned",
      );
    }
    this.deadLetterQueueUrl = response.QueueUrl;
    return response.QueueUrl;
  }

  private async sendToDeadLetterQueue(message: Message): Promise<void> {
    const queueUrl = await this.getDeadLetterQueueUrl();
    const fallbackId = createHash("sha256")
      .update(`${message.Body ?? ""}:${message.ReceiptHandle ?? ""}`)
      .digest("hex");
    const identity = message.MessageId ?? fallbackId;
    await this.sqs.send(
      new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: message.Body ?? "",
        MessageGroupId: identity,
        MessageDeduplicationId: identity,
      }),
    );
  }

  private async deleteMessage(message: Message): Promise<void> {
    if (message.ReceiptHandle === undefined) {
      throw new Error("SQS message receipt handle is missing");
    }
    await this.sqs.send(
      new DeleteMessageCommand({
        QueueUrl: await this.getMainQueueUrl(),
        ReceiptHandle: message.ReceiptHandle,
      }),
    );
  }

  private delay(milliseconds: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  }
}
