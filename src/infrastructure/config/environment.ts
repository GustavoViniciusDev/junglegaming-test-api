import { z } from "zod";

const positiveInteger = z.coerce.number().int().positive();
const nonEmpty = z.string().trim().min(1);
const booleanFromEnvironment = z
  .enum(["true", "false"])
  .default("false")
  .transform((value) => value === "true");
const swaggerEnabledFromEnvironment = z
  .enum(["true", "false"])
  .default("true")
  .transform((value) => value === "true");

const environmentSchema = z
  .object({
    NODE_ENV: z
      .enum(["development", "test", "production"])
      .default("development"),
    PORT: positiveInteger.max(65535).default(3000),
    LOG_LEVEL: z
      .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
      .default("info"),
    SWAGGER_ENABLED: swaggerEnabledFromEnvironment,
    POSTGRES_HOST: nonEmpty,
    POSTGRES_PORT: positiveInteger.max(65535).default(5432),
    POSTGRES_DB: nonEmpty,
    POSTGRES_USER: nonEmpty,
    POSTGRES_PASSWORD: z.string().min(1),
    AWS_REGION: nonEmpty,
    AWS_ACCESS_KEY_ID: nonEmpty,
    AWS_SECRET_ACCESS_KEY: nonEmpty,
    SQS_ENDPOINT: z
      .url()
      .refine((value) => ["http:", "https:"].includes(new URL(value).protocol)),
    SQS_MAX_RECEIVE_COUNT: positiveInteger.max(1000).default(5),
    SQS_WAGER_TRANSACTION_QUEUE_NAME: nonEmpty.default(
      "wager-transactions.fifo",
    ),
    SQS_WAGER_TRANSACTION_DLQ_NAME: nonEmpty.default(
      "wager-transactions-dlq.fifo",
    ),
    SQS_WAGER_EVENTS_QUEUE_NAME: nonEmpty.default("wager-events.fifo"),
    SQS_CONSUMER_ENABLED: booleanFromEnvironment,
    SQS_CONSUMER_WAIT_TIME_SECONDS: z.coerce
      .number()
      .int()
      .min(0)
      .max(20)
      .default(20),
    SQS_CONSUMER_MAX_MESSAGES: positiveInteger.max(10).default(10),
    SQS_CONSUMER_VISIBILITY_TIMEOUT_SECONDS: positiveInteger
      .max(43200)
      .default(60),
    SQS_CONSUMER_SHUTDOWN_TIMEOUT_MS: positiveInteger.max(60000).default(15000),
    REFERENCE_RETRY_BASE_DELAY_MS: positiveInteger.max(3_600_000).default(1000),
    REFERENCE_RETRY_MAX_ATTEMPTS: positiveInteger.max(20).default(8),
    REFERENCE_RETRY_BATCH_SIZE: positiveInteger.max(1000).default(50),
    REFERENCE_RETRY_POLL_INTERVAL_MS: positiveInteger.max(60_000).default(1000),
    OUTBOX_PUBLISHER_ENABLED: booleanFromEnvironment,
    OUTBOX_PUBLISHER_BATCH_SIZE: positiveInteger.max(100).default(25),
    OUTBOX_PUBLISHER_POLL_INTERVAL_MS: positiveInteger
      .max(60_000)
      .default(1000),
    OUTBOX_PUBLISHER_RETRY_BASE_DELAY_MS: positiveInteger
      .max(3_600_000)
      .default(1000),
    OUTBOX_PUBLISHER_RETRY_MAX_DELAY_MS: positiveInteger
      .max(86_400_000)
      .default(60_000),
    OUTBOX_PUBLISHER_SHUTDOWN_TIMEOUT_MS: positiveInteger
      .max(60_000)
      .default(15_000),
    DEPENDENCY_TIMEOUT_MS: positiveInteger.max(30000).default(3000),
  })
  .refine(
    (environment) =>
      environment.OUTBOX_PUBLISHER_RETRY_MAX_DELAY_MS >=
      environment.OUTBOX_PUBLISHER_RETRY_BASE_DELAY_MS,
    { path: ["OUTBOX_PUBLISHER_RETRY_MAX_DELAY_MS"] },
  );

export type Environment = z.infer<typeof environmentSchema>;

export class EnvironmentValidationError extends Error {}

export function parseEnvironment(
  input: Record<string, string | undefined>,
): Environment {
  const result = environmentSchema.safeParse(input);
  if (!result.success) {
    const fields = [
      ...new Set(result.error.issues.map((issue) => issue.path.join("."))),
    ];
    throw new EnvironmentValidationError(
      `Invalid environment configuration: ${fields.join(", ")}`,
    );
  }
  return result.data;
}
