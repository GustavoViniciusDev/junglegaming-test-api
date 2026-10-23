import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { GetQueueUrlCommand, SQSClient } from "@aws-sdk/client-sqs";
import { MikroORM } from "@mikro-orm/postgresql";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { Logger } from "nestjs-pino";
import { AppModule } from "../src/app.module";
import { ENVIRONMENT } from "../src/infrastructure/config/config.module";
import { parseEnvironment } from "../src/infrastructure/config/environment";
import { validEnvironment } from "./environment.fixture";

describe("infrastructure HTTP endpoints", () => {
  let app: INestApplication;
  let baseUrl: string;
  let postgresAvailable = true;
  let sqsAvailable = true;
  let missingQueue = false;
  const checkedQueues = new Set<string>();
  let databaseClosed = false;
  let sqsDestroyed = false;

  beforeAll(async () => {
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(ENVIRONMENT)
      .useValue(
        parseEnvironment({
          ...validEnvironment,
          NODE_ENV: "test",
          LOG_LEVEL: "silent",
        }),
      )
      .overrideProvider(MikroORM)
      .useValue({
        em: {
          getConnection: () => ({
            execute: async () => {
              if (!postgresAvailable) throw new Error("PostgreSQL unavailable");
              return [{ result: 1 }];
            },
          }),
        },
        close: async () => {
          databaseClosed = true;
        },
      })
      .overrideProvider(SQSClient)
      .useValue({
        send: async (command: GetQueueUrlCommand) => {
          if (!sqsAvailable) throw new Error("SQS unavailable");
          if (command instanceof GetQueueUrlCommand) {
            const name = command.input.QueueName;
            if (!name || missingQueue) throw new Error("Queue does not exist");
            checkedQueues.add(name);
            return { QueueUrl: `http://localhost:4566/000000000000/${name}` };
          }
          return { Attributes: { QueueArn: "test-queue-arn" } };
        },
        destroy: () => {
          sqsDestroyed = true;
        },
      })
      .compile();
    app = module.createNestApplication();
    app.useLogger(app.get(Logger));
    await app.listen(0, "127.0.0.1");
    baseUrl = await app.getUrl();
  });

  afterAll(async () => {
    await app.close();
    expect(databaseClosed).toBe(true);
    expect(sqsDestroyed).toBe(true);
  });

  test("reports liveness independently of dependencies", async () => {
    postgresAvailable = false;
    sqsAvailable = false;
    try {
      expect((await fetch(`${baseUrl}/health/live`)).status).toBe(200);
    } finally {
      postgresAvailable = true;
      sqsAvailable = true;
    }
  });

  test("reports readiness only after checking PostgreSQL and all queues", async () => {
    const response = await fetch(`${baseUrl}/health/ready`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: "ok",
      dependencies: { postgres: "up", sqs: "up" },
    });
    expect([...checkedQueues].sort()).toEqual([
      "wager-events.fifo",
      "wager-transactions-dlq.fifo",
      "wager-transactions.fifo",
    ]);
  });

  test("returns 503 when PostgreSQL is unavailable", async () => {
    postgresAvailable = false;
    try {
      const response = await fetch(`${baseUrl}/health/ready`);
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({
        dependencies: { postgres: "down", sqs: "up" },
      });
    } finally {
      postgresAvailable = true;
    }
  });

  test("returns 503 when SQS is unavailable or a required queue is absent", async () => {
    sqsAvailable = false;
    try {
      expect((await fetch(`${baseUrl}/health/ready`)).status).toBe(503);
    } finally {
      sqsAvailable = true;
    }
    missingQueue = true;
    try {
      expect((await fetch(`${baseUrl}/health/ready`)).status).toBe(503);
    } finally {
      missingQueue = false;
    }
  });

  test("exposes real runtime metrics in Prometheus format", async () => {
    const response = await fetch(`${baseUrl}/metrics`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/plain");
    const metrics = await response.text();
    expect(metrics).toContain("# TYPE process_start_time_seconds gauge");
    expect(metrics).toMatch(/^process_start_time_seconds \d+(?:\.\d+)?$/m);
    expect(metrics).toContain("# TYPE wagering_transactions_total counter");
    expect(metrics).toContain(
      "# TYPE wagering_processing_duration_seconds histogram",
    );
    expect(metrics).toContain("wagering_outbox_lag_seconds 0");
  });
});
