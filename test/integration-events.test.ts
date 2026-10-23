import { describe, expect, test } from "bun:test";
import {
  outboxMessageFromRecord,
  outboxMessageToRecord,
} from "../src/infrastructure/database/domain-mappers";
import { Money } from "../src/shared/domain/money";
import { InvalidIntegrationEventError } from "../src/shared/domain/integration-event";
import { OutboxMessage } from "../src/outbox/domain/outbox-message";
import { LedgerDirection } from "../src/wallet/domain/ledger-direction";
import { WalletBalanceChanged } from "../src/wallet/domain/integration-events/wallet-balance-changed";
import { WagerTransactionRejectionCode } from "../src/wagering/domain/wager-transaction-failure-code";
import { WagerTransactionKind } from "../src/wagering/domain/wager-transaction-kind";
import { WagerTransaction } from "../src/wagering/domain/wager-transaction";
import { WagerTransactionPendingReference } from "../src/wagering/domain/integration-events/wager-transaction-pending-reference";
import { WagerTransactionProcessed } from "../src/wagering/domain/integration-events/wager-transaction-processed";
import { WagerTransactionRejected } from "../src/wagering/domain/integration-events/wager-transaction-rejected";

const createdAt = new Date("2026-01-01T10:00:00.000Z");
const processedAt = new Date("2026-01-01T10:01:00.000Z");
const waitingAt = new Date("2026-01-01T10:02:00.000Z");

function transaction(
  kind: Exclude<
    WagerTransactionKind,
    WagerTransactionKind.OPENING
  > = WagerTransactionKind.BET,
): WagerTransaction {
  const value = WagerTransaction.create(
    {
      id: "transaction-1",
      providerId: "provider-1",
      externalTransactionId: "external-1",
      idempotencyKey: "idempotency-1",
      payloadHash: "payload-hash",
      walletId: "wallet-1",
      playerId: "player-1",
      roundId: "round-1",
      gameId: "game-1",
      kind,
      money: Money.from({ amount: "25.40", currency: "BRL" }),
      referenceExternalTransactionId:
        kind === WagerTransactionKind.REFUND ||
        kind === WagerTransactionKind.ROLLBACK
          ? "external-original"
          : null,
    },
    createdAt,
  );
  return value;
}

describe("Wager transaction integration events", () => {
  test("creates versioned processed, rejected and pending-reference events", () => {
    const processed = transaction();
    processed.markProcessed(
      Money.from({ amount: "25.40", currency: "BRL" }),
      processedAt,
    );
    const rejected = transaction();
    rejected.reject(
      WagerTransactionRejectionCode.INSUFFICIENT_FUNDS,
      processedAt,
    );
    const pending = transaction(WagerTransactionKind.REFUND);
    pending.markPendingReference(waitingAt);

    expect(
      WagerTransactionProcessed.fromTransaction("event-processed", processed)
        .eventType,
    ).toBe("wager.transaction.processed.v1");
    expect(
      WagerTransactionRejected.fromTransaction("event-rejected", rejected)
        .eventType,
    ).toBe("wager.transaction.rejected.v1");
    expect(
      WagerTransactionPendingReference.fromTransaction("event-pending", pending)
        .eventType,
    ).toBe("wager.transaction.pending-reference.v1");
  });

  test("serializes transaction event data deterministically with ISO timestamps and decimal strings", () => {
    const value = transaction();
    value.markProcessed(
      Money.from({ amount: "25.40", currency: "BRL" }),
      processedAt,
    );
    const first = WagerTransactionProcessed.fromTransaction("event-1", value);
    const second = WagerTransactionProcessed.fromTransaction("event-1", value);
    expect(JSON.stringify(first.toJSON())).toBe(
      JSON.stringify(second.toJSON()),
    );
    expect(first.toJSON()).toEqual({
      id: "event-1",
      aggregateId: "transaction-1",
      eventType: "wager.transaction.processed.v1",
      occurredAt: processedAt.toISOString(),
      payload: {
        transactionId: "transaction-1",
        providerId: "provider-1",
        externalTransactionId: "external-1",
        walletId: "wallet-1",
        playerId: "player-1",
        kind: "BET",
        money: { amount: "25.40", currency: "BRL" },
        processedAt: processedAt.toISOString(),
      },
    });
    expect(typeof first.payload.money.amount).toBe("string");
  });

  test("allows internal OPENING transactions without provider metadata", () => {
    const opening = WagerTransaction.createOpening(
      {
        id: "opening-1",
        walletId: "wallet-1",
        playerId: "player-1",
        idempotencyKey: "opening-key",
        payloadHash: "opening-hash",
        money: Money.zero("BRL"),
      },
      createdAt,
    );
    opening.markProcessed(Money.zero("BRL"), processedAt);
    const event = WagerTransactionProcessed.fromTransaction(
      "opening-event",
      opening,
    );
    expect(event.payload.providerId).toBeNull();
    expect(event.payload.externalTransactionId).toBeNull();
    expect(event.payload.money).toEqual({ amount: "0.00", currency: "BRL" });
  });

  test("includes rejection and unresolved reference details", () => {
    const rejected = transaction();
    rejected.reject(
      WagerTransactionRejectionCode.REFERENCE_NOT_FOUND,
      processedAt,
    );
    expect(
      WagerTransactionRejected.fromTransaction("rejected-event", rejected)
        .payload.failureCode,
    ).toBe(WagerTransactionRejectionCode.REFERENCE_NOT_FOUND);

    const pending = transaction(WagerTransactionKind.REFUND);
    pending.markPendingReference(waitingAt);
    const event = WagerTransactionPendingReference.fromTransaction(
      "pending-event",
      pending,
    );
    expect(event.payload.referenceExternalTransactionId).toBe(
      "external-original",
    );
    expect(event.toJSON().payload.pendingAt).toBe(waitingAt.toISOString());
  });

  test("rejects event creation when transaction status does not match", () => {
    expect(() =>
      WagerTransactionProcessed.fromTransaction("event-1", transaction()),
    ).toThrow(InvalidIntegrationEventError);
    expect(() =>
      WagerTransactionRejected.fromTransaction("event-2", transaction()),
    ).toThrow(InvalidIntegrationEventError);
    expect(() =>
      WagerTransactionPendingReference.fromTransaction(
        "event-3",
        transaction(),
      ),
    ).toThrow(InvalidIntegrationEventError);
  });
});

describe("WalletBalanceChanged", () => {
  function createWalletEvent() {
    return WalletBalanceChanged.create({
      id: "wallet-event-1",
      walletId: "wallet-1",
      playerId: "player-1",
      direction: LedgerDirection.CREDIT,
      money: Money.from({ amount: "10.25", currency: "BRL" }),
      balanceBefore: Money.from({ amount: "20.00", currency: "BRL" }),
      balanceAfter: Money.from({ amount: "30.25", currency: "BRL" }),
      transactionId: "transaction-1",
      occurredAt: processedAt,
    });
  }

  test("serializes all monetary values as decimal strings", () => {
    const event = createWalletEvent();
    expect(event.eventType).toBe("wallet.balance.changed.v1");
    expect(event.aggregateId).toBe("wallet-1");
    expect(event.toJSON().occurredAt).toBe(processedAt.toISOString());
    expect(event.payload).toMatchObject({
      money: { amount: "10.25", currency: "BRL" },
      balanceBefore: { amount: "20.00", currency: "BRL" },
      balanceAfter: { amount: "30.25", currency: "BRL" },
      occurredAt: processedAt.toISOString(),
    });
    for (const amount of [
      event.payload.money.amount,
      event.payload.balanceBefore.amount,
      event.payload.balanceAfter.amount,
    ]) {
      expect(typeof amount).toBe("string");
    }
  });

  test("keeps event state immutable and returns defensive timestamp copies", () => {
    const event = createWalletEvent();
    const returnedDate = event.occurredAt;
    returnedDate.setUTCFullYear(2030);
    expect(event.occurredAt).toEqual(processedAt);
    expect(Object.isFrozen(event)).toBe(true);
    expect(Object.isFrozen(event.payload)).toBe(true);
    expect(Object.isFrozen(event.payload.money)).toBe(true);
  });
});

describe("OutboxMessage", () => {
  function event() {
    const wager = transaction();
    wager.markProcessed(
      Money.from({ amount: "25.40", currency: "BRL" }),
      processedAt,
    );
    return WagerTransactionProcessed.fromTransaction("event-outbox", wager);
  }

  test("creates an immediately eligible unpublished message from an event", () => {
    const integrationEvent = event();
    const message = OutboxMessage.fromEvent(integrationEvent);
    expect(message.id).toBe(integrationEvent.id);
    expect(message.aggregateId).toBe(integrationEvent.aggregateId);
    expect(message.eventType).toBe(integrationEvent.eventType);
    expect(message.payload).toEqual(integrationEvent.payload);
    expect(message.occurredAt).toEqual(integrationEvent.occurredAt);
    expect(message.attempts).toBe(0);
    expect(message.publishedAt).toBeNull();
    expect(message.nextAttemptAt).toEqual(message.occurredAt);
  });

  test("rehydrates complete delivery state without losing data", () => {
    const state = {
      ...OutboxMessage.fromEvent(event()).toJSON(),
      occurredAt: processedAt,
      nextAttemptAt: waitingAt,
      publishedAt: new Date("2026-01-01T10:03:00.000Z"),
      attempts: 3,
    };
    const message = OutboxMessage.rehydrate(state);
    expect(message.toJSON()).toEqual({
      ...state,
      occurredAt: processedAt.toISOString(),
      nextAttemptAt: waitingAt.toISOString(),
      publishedAt: "2026-01-01T10:03:00.000Z",
    });
  });

  test("maps OutboxMessage to its persistence record and back", () => {
    const original = OutboxMessage.fromEvent(event());
    const record = outboxMessageToRecord(original);
    const restored = outboxMessageFromRecord(record);
    expect(restored.toJSON()).toEqual(original.toJSON());
    expect(record.payload).toEqual(original.payload);
  });

  test("preserves JSON object inputs without retaining mutable references", () => {
    const original = OutboxMessage.fromEvent(event());
    const record = outboxMessageToRecord(original);
    expect(record.payload).toEqual(original.payload);
    expect(Object.isFrozen(record.payload)).toBe(true);
  });
});
