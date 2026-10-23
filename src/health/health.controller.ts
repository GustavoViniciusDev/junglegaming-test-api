import {
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";
import { MikroORM } from "@mikro-orm/postgresql";
import {
  Controller,
  Get,
  Inject,
  ServiceUnavailableException,
} from "@nestjs/common";
import { PinoLogger } from "nestjs-pino";
import { ENVIRONMENT } from "../infrastructure/config/config.module";
import type { Environment } from "../infrastructure/config/environment";

const queueNames = [
  "wager-transactions.fifo",
  "wager-transactions-dlq.fifo",
  "wager-events.fifo",
];

@Controller("health")
export class HealthController {
  constructor(
    @Inject(MikroORM) private readonly orm: MikroORM,
    @Inject(SQSClient) private readonly sqs: SQSClient,
    @Inject(ENVIRONMENT) private readonly environment: Environment,
    @Inject(PinoLogger) private readonly logger: PinoLogger,
  ) {}

  @Get("live")
  live() {
    return { status: "ok" };
  }

  @Get("ready")
  async ready() {
    const results = await Promise.allSettled([
      this.orm.em.getConnection().execute("select 1"),
      this.checkQueues(),
    ]);
    const dependencies = {
      postgres: results[0]?.status === "fulfilled" ? "up" : "down",
      sqs: results[1]?.status === "fulfilled" ? "up" : "down",
    };
    if (dependencies.postgres === "down" || dependencies.sqs === "down") {
      this.logger.warn({ dependencies }, "Readiness check failed");
      throw new ServiceUnavailableException({ status: "error", dependencies });
    }
    return { status: "ok", dependencies };
  }

  private async checkQueues(): Promise<void> {
    const abortSignal = AbortSignal.timeout(
      this.environment.DEPENDENCY_TIMEOUT_MS,
    );
    await Promise.all(
      queueNames.map(async (QueueName) => {
        const { QueueUrl } = await this.sqs.send(
          new GetQueueUrlCommand({ QueueName }),
          { abortSignal },
        );
        if (!QueueUrl) throw new Error("SQS did not return a queue URL");
        await this.sqs.send(
          new GetQueueAttributesCommand({
            QueueUrl,
            AttributeNames: ["QueueArn"],
          }),
          { abortSignal },
        );
      }),
    );
  }
}
