import { describe, expect, test } from "bun:test";
import { parseEnvironment } from "../src/infrastructure/config/environment";
import { validEnvironment } from "./environment.fixture";

describe("environment validation", () => {
  test("accepts local configuration and applies bounded defaults", () => {
    expect(parseEnvironment(validEnvironment).DEPENDENCY_TIMEOUT_MS).toBe(3000);
    expect(
      parseEnvironment(validEnvironment).REFERENCE_RETRY_MAX_ATTEMPTS,
    ).toBe(8);
    expect(parseEnvironment(validEnvironment).SQS_CONSUMER_ENABLED).toBe(false);
    expect(parseEnvironment(validEnvironment).OUTBOX_PUBLISHER_ENABLED).toBe(
      false,
    );
    expect(
      parseEnvironment(validEnvironment).OUTBOX_PUBLISHER_RETRY_MAX_DELAY_MS,
    ).toBe(60_000);
    expect(
      parseEnvironment(validEnvironment).SQS_CONSUMER_WAIT_TIME_SECONDS,
    ).toBe(20);
  });

  test("rejects missing credentials without exposing their values", () => {
    expect(() =>
      parseEnvironment({ ...validEnvironment, POSTGRES_PASSWORD: "" }),
    ).toThrow("POSTGRES_PASSWORD");
    expect(() =>
      parseEnvironment({ ...validEnvironment, AWS_REGION: undefined }),
    ).toThrow("AWS_REGION");
  });

  test("rejects invalid ports, timeouts, protocols and redrive counts", () => {
    for (const invalid of [
      { PORT: "65536" },
      { POSTGRES_PORT: "abc" },
      { DEPENDENCY_TIMEOUT_MS: "0" },
      { SQS_ENDPOINT: "file:///tmp/queue" },
      { SQS_MAX_RECEIVE_COUNT: "1.5" },
      { SQS_CONSUMER_ENABLED: "yes" },
      { SQS_CONSUMER_MAX_MESSAGES: "11" },
      { SQS_CONSUMER_WAIT_TIME_SECONDS: "21" },
      { REFERENCE_RETRY_BASE_DELAY_MS: "0" },
      { REFERENCE_RETRY_MAX_ATTEMPTS: "21" },
      { REFERENCE_RETRY_BATCH_SIZE: "1001" },
      { OUTBOX_PUBLISHER_BATCH_SIZE: "101" },
      {
        OUTBOX_PUBLISHER_RETRY_BASE_DELAY_MS: "5000",
        OUTBOX_PUBLISHER_RETRY_MAX_DELAY_MS: "1000",
      },
    ]) {
      expect(() =>
        parseEnvironment({ ...validEnvironment, ...invalid }),
      ).toThrow("Invalid environment configuration");
    }
  });

  test("reports invalid field names without disclosing input values", () => {
    try {
      parseEnvironment({
        ...validEnvironment,
        POSTGRES_PORT: "sensitive-value",
      });
      throw new Error("Expected configuration validation to fail");
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(Error);
      if (error instanceof Error) {
        expect(error.message).toContain("POSTGRES_PORT");
        expect(error.message).not.toContain("sensitive-value");
      }
    }
  });
});
