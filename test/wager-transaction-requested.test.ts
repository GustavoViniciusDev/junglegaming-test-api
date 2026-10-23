import { describe, expect, test } from "bun:test";
import {
  parseWagerTransactionRequested,
  PermanentWagerMessageError,
  WAGER_TRANSACTION_REQUESTED_TYPE,
} from "../src/wagering/application/wager-transaction-requested";

const validData = {
  providerId: "provider-a",
  externalTransactionId: "external-a",
  idempotencyKey: "key-a",
  playerId: "player-a",
  walletId: "wallet-a",
  roundId: "round-a",
  gameId: "game-a",
  kind: "BET",
  money: { amount: "10.00", currency: "BRL" },
};

function body(
  data: unknown = validData,
  overrides: Record<string, unknown> = {},
) {
  return JSON.stringify({
    messageId: "message-a",
    type: WAGER_TRANSACTION_REQUESTED_TYPE,
    occurredAt: "2026-10-22T12:00:00.000Z",
    data,
    ...overrides,
  });
}

describe("WagerTransactionRequested envelope", () => {
  test("parses a versioned envelope and preserves the decimal string", () => {
    const parsed = parseWagerTransactionRequested(body());
    expect(parsed.messageId).toBe("message-a");
    expect(parsed.type).toBe("wager.transaction.requested.v1");
    expect(parsed.data.money.amount).toBe("10.00");
    expect(typeof parsed.data.money.amount).toBe("string");
    expect(parsed.data.idempotencyKey).toBe("key-a");
  });

  test("rejects malformed JSON, unknown type, invalid envelope and invalid fields permanently", () => {
    const invalidBodies = [
      "{not-json",
      body(validData, { type: "wager.transaction.requested.v2" }),
      body(validData, { messageId: " " }),
      body(validData, { occurredAt: "not-a-date" }),
      body(null),
      body({ ...validData, money: undefined }),
      body({ ...validData, money: { amount: 10, currency: "BRL" } }),
      body({ ...validData, money: { amount: "10.0", currency: "BRL" } }),
      body({ ...validData, money: { amount: "10.00", currency: "brl" } }),
      body({ ...validData, kind: "OPENING" }),
      body({ ...validData, kind: "REFUND" }),
      body({ ...validData, kind: "ROLLBACK" }),
      body({ ...validData, referenceExternalTransactionId: "reference-a" }),
      body({
        ...validData,
        kind: "LOSS",
        referenceExternalTransactionId: "reference-a",
      }),
      body({ ...validData, idempotencyKey: " " }),
      body(validData, { extraTransportField: "message" }),
    ];

    for (const invalidBody of invalidBodies) {
      expect(() => parseWagerTransactionRequested(invalidBody)).toThrow(
        PermanentWagerMessageError,
      );
    }

    for (const field of [
      "providerId",
      "externalTransactionId",
      "idempotencyKey",
      "playerId",
      "walletId",
      "roundId",
      "gameId",
      "kind",
      "money",
    ]) {
      const incompleteData = Object.fromEntries(
        Object.entries(validData).filter(([key]) => key !== field),
      );
      expect(() =>
        parseWagerTransactionRequested(body(incompleteData)),
      ).toThrow(PermanentWagerMessageError);
    }
  });
});
