import "reflect-metadata";
import { MikroORM } from "@mikro-orm/postgresql";
import {
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";
import { createHash } from "node:crypto";
import { databaseConfig } from "../src/infrastructure/database/database.config";
import { MikroOrmWagerTransactionProcessingStore } from "../src/wagering/infrastructure/mikro-orm-wager-transaction-processing-store";
import { ProcessWagerTransaction } from "../src/wagering/application/process-wager-transaction";
import type { ProcessWagerTransactionInput } from "../src/wagering/application/process-wager-transaction";
import { RecoverPendingReferences } from "../src/wagering/application/recover-pending-references";
import { parseWagerTransactionRequested } from "../src/wagering/application/wager-transaction-requested";
import { MikroOrmOutboxPublishingStore } from "../src/outbox/infrastructure/mikro-orm-outbox-publishing-store";
import { AwsSqsIntegrationEventQueue } from "../src/outbox/infrastructure/aws-sqs-integration-event-queue";
import { PublishOutboxMessages } from "../src/outbox/application/publish-outbox-messages";

type WorkerRequest =
  | { action: "process"; inputs: ProcessWagerTransactionInput[] }
  | { action: "recover" }
  | { action: "consume"; queueUrl: string; crashAfterCommit?: boolean }
  | {
      action: "publish";
      queueName: string;
      crashStage?: "before-send" | "after-send";
    };

async function main(): Promise<void> {
  const encoded = Bun.argv[2];
  if (encoded === undefined) throw new Error("Worker request is required");
  const request = JSON.parse(encoded) as WorkerRequest;
  const environment = (
    await import("../src/infrastructure/config/environment")
  ).parseEnvironment(process.env);
  const orm = await MikroORM.init(databaseConfig(environment));
  let sqs: SQSClient | null = null;
  try {
    const store = new MikroOrmWagerTransactionProcessingStore(orm);
    const processor = new ProcessWagerTransaction(store);
    if (request.action === "recover") {
      const recovery = new RecoverPendingReferences(store, processor, {
        baseDelayMs: 1,
        maxAttempts: 8,
        batchSize: 20,
      });
      const recovered = await recovery.runBatch(new Date(Date.now() + 10_000));
      process.stdout.write(JSON.stringify({ recovered }));
      return;
    }

    if (request.action === "consume") {
      sqs = new SQSClient({
        region: environment.AWS_REGION,
        endpoint: environment.SQS_ENDPOINT,
        credentials: {
          accessKeyId: environment.AWS_ACCESS_KEY_ID,
          secretAccessKey: environment.AWS_SECRET_ACCESS_KEY,
        },
        maxAttempts: 1,
      });
      for (let receiveAttempt = 0; receiveAttempt < 30; receiveAttempt += 1) {
        const response = await sqs.send(
          new ReceiveMessageCommand({
            QueueUrl: request.queueUrl,
            MaxNumberOfMessages: 1,
            WaitTimeSeconds: 1,
            VisibilityTimeout: 1,
          }),
        );
        const message = response.Messages?.[0];
        if (
          message?.Body === undefined ||
          message.ReceiptHandle === undefined
        ) {
          continue;
        }
        const envelope = parseWagerTransactionRequested(message.Body);
        const payloadHash = createHash("sha256")
          .update(message.Body, "utf8")
          .digest("hex");
        const processing = await processor.executeFromInbox(envelope.data, {
          consumerName: "wager-transaction-consumer.v1",
          messageId: envelope.messageId,
          payloadHash,
          receivedAt: new Date(),
        });
        if (request.crashAfterCommit === true) {
          process.stdout.write(
            `${JSON.stringify({ committed: true, transactionId: processing.result.transactionId, inboxDuplicate: processing.inboxDuplicate })}\n`,
          );
          await new Promise<void>(() => {});
          return;
        }
        await sqs.send(
          new DeleteMessageCommand({
            QueueUrl: request.queueUrl,
            ReceiptHandle: message.ReceiptHandle,
          }),
        );
        process.stdout.write(
          JSON.stringify({
            committed: true,
            transactionId: processing.result.transactionId,
            inboxDuplicate: processing.inboxDuplicate,
          }),
        );
        return;
      }
      throw new Error("No SQS message became available for the worker");
    }

    if (request.action === "publish") {
      sqs = new SQSClient({
        region: environment.AWS_REGION,
        endpoint: environment.SQS_ENDPOINT,
        credentials: {
          accessKeyId: environment.AWS_ACCESS_KEY_ID,
          secretAccessKey: environment.AWS_SECRET_ACCESS_KEY,
        },
        maxAttempts: 1,
      });
      const queue = new AwsSqsIntegrationEventQueue(sqs, {
        ...environment,
        SQS_WAGER_EVENTS_QUEUE_NAME: request.queueName,
      });
      const store = new MikroOrmOutboxPublishingStore(orm);
      if (request.crashStage !== undefined) {
        await store.publishDueMessages({
          now: new Date(Date.now() + 30_000),
          batchSize: 1,
          retry: { baseDelayMs: 1, maxDelayMs: 100 },
          publish: async (event) => {
            if (request.crashStage === "before-send") {
              process.stdout.write(
                `${JSON.stringify({ claimed: true, eventId: event.id })}\n`,
              );
              await new Promise<void>(() => {});
            }
            await queue.publish(event);
            process.stdout.write(
              `${JSON.stringify({ sent: true, eventId: event.id })}\n`,
            );
            await new Promise<void>(() => {});
          },
        });
        return;
      }
      const publisher = new PublishOutboxMessages(store, queue, {
        batchSize: 25,
        baseDelayMs: 1,
        maxDelayMs: 100,
      });
      const batch = await publisher.runBatch(new Date(Date.now() + 30_000));
      process.stdout.write(JSON.stringify({ outcomes: batch.outcomes }));
      return;
    }

    const results = await Promise.all(
      request.inputs.map((input) => processor.execute(input)),
    );
    process.stdout.write(JSON.stringify({ results }));
  } finally {
    sqs?.destroy();
    await orm.close(true);
  }
}

main().catch((error: unknown) => {
  process.stderr.write(
    error instanceof Error
      ? `${error.name}: ${error.message}`
      : "Unknown worker failure",
  );
  process.exitCode = 1;
});
