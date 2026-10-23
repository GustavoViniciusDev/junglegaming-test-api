import { describe, expect, test } from "bun:test";
import { nextOutboxAttemptAt } from "../src/outbox/application/outbox-retry-policy";
import { outboxFifoIdentity } from "../src/outbox/infrastructure/outbox-fifo-identity";

const now = new Date("2026-01-01T00:00:00.000Z");

describe("outbox retry policy", () => {
  test("uses deterministic exponential delay capped at the configured maximum", () => {
    const policy = { baseDelayMs: 1000, maxDelayMs: 5000 };
    expect(nextOutboxAttemptAt(now, 1, policy).toISOString()).toBe(
      "2026-01-01T00:00:02.000Z",
    );
    expect(nextOutboxAttemptAt(now, 2, policy).getTime() - now.getTime()).toBe(
      4000,
    );
    expect(nextOutboxAttemptAt(now, 3, policy).getTime() - now.getTime()).toBe(
      5000,
    );
    expect(nextOutboxAttemptAt(now, 20, policy).getTime() - now.getTime()).toBe(
      5000,
    );
  });

  test("rejects invalid policy input", () => {
    expect(() =>
      nextOutboxAttemptAt(now, 0, { baseDelayMs: 1000, maxDelayMs: 5000 }),
    ).toThrow("Outbox retry policy values must be valid");
  });
});

describe("outbox FIFO identity", () => {
  test("uses stable event deduplication and aggregate-specific group identities", () => {
    const event = {
      id: "event-1",
      aggregateId: "wallet-1",
      eventType: "wager.transaction.processed.v1",
      occurredAt: now.toISOString(),
      payload: { amount: "10.00", currency: "BRL" },
    };
    const identity = outboxFifoIdentity(event);
    expect(identity).toEqual(outboxFifoIdentity(event));
    expect(identity.messageDeduplicationId).toBe("event-1");
    expect(identity.messageGroupId).not.toBe(
      outboxFifoIdentity({
        ...event,
        aggregateId: "wallet-2",
      }).messageGroupId,
    );
    expect(identity.messageGroupId).toHaveLength(64);
  });
});
