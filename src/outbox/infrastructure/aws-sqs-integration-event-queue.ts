import {
  GetQueueUrlCommand,
  SendMessageCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";
import { Inject, Injectable } from "@nestjs/common";
import type { IntegrationEventJSON } from "../../shared/domain/integration-event";
import type { IntegrationEventQueue } from "../application/publish-outbox-messages";
import { ENVIRONMENT } from "../../infrastructure/config/config.module";
import type { Environment } from "../../infrastructure/config/environment";
import { outboxFifoIdentity } from "./outbox-fifo-identity";

@Injectable()
export class AwsSqsIntegrationEventQueue implements IntegrationEventQueue {
  private queueUrl: string | null = null;

  constructor(
    @Inject(SQSClient) private readonly sqs: SQSClient,
    @Inject(ENVIRONMENT) private readonly environment: Environment,
  ) {}

  async publish(event: IntegrationEventJSON): Promise<void> {
    const identity = outboxFifoIdentity(event);
    await this.sqs.send(
      new SendMessageCommand({
        QueueUrl: await this.getQueueUrl(),
        MessageBody: JSON.stringify(event),
        MessageGroupId: identity.messageGroupId,
        MessageDeduplicationId: identity.messageDeduplicationId,
      }),
    );
  }

  private async getQueueUrl(): Promise<string> {
    if (this.queueUrl !== null) return this.queueUrl;
    const response = await this.sqs.send(
      new GetQueueUrlCommand({
        QueueName: this.environment.SQS_WAGER_EVENTS_QUEUE_NAME,
      }),
    );
    if (response.QueueUrl === undefined) {
      throw new Error("Wager events queue URL was not returned");
    }
    this.queueUrl = response.QueueUrl;
    return response.QueueUrl;
  }
}
