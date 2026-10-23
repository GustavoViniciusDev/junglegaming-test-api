import { describe, expect, test } from "bun:test";
import {
  canonicalizeJson,
  hashWagerTransactionBusinessPayload,
  type WagerTransactionBusinessPayload,
} from "../src/wagering/application/canonical-business-payload";
import { WagerTransactionKind } from "../src/wagering/domain/wager-transaction-kind";

function payload(): WagerTransactionBusinessPayload {
  return {
    providerId: "provider-1",
    externalTransactionId: "external-1",
    playerId: "player-1",
    walletId: "wallet-1",
    roundId: "round-1",
    gameId: "game-1",
    kind: WagerTransactionKind.BET,
    money: { amount: "10.00", currency: "BRL" },
  };
}

describe("Wager transaction business payload canonicalization", () => {
  test("produces the same hash for the same business payload", () => {
    expect(hashWagerTransactionBusinessPayload(payload())).toBe(
      hashWagerTransactionBusinessPayload(payload()),
    );
  });

  test("sorts object keys recursively regardless of their input order", () => {
    const first = {
      ...payload(),
      money: { amount: "10.00", currency: "BRL" },
    };
    const reordered = {
      money: { currency: "BRL", amount: "10.00" },
      kind: WagerTransactionKind.BET as const,
      gameId: "game-1",
      roundId: "round-1",
      walletId: "wallet-1",
      playerId: "player-1",
      externalTransactionId: "external-1",
      providerId: "provider-1",
    };
    expect(hashWagerTransactionBusinessPayload(first)).toBe(
      hashWagerTransactionBusinessPayload(reordered),
    );
  });

  test.each([
    ["amount", { money: { amount: "10.01", currency: "BRL" } }],
    ["currency", { money: { amount: "10.00", currency: "USD" } }],
    ["providerId", { providerId: "provider-2" }],
    ["externalTransactionId", { externalTransactionId: "external-2" }],
    ["playerId", { playerId: "player-2" }],
    ["walletId", { walletId: "wallet-2" }],
    ["roundId", { roundId: "round-2" }],
    ["gameId", { gameId: "game-2" }],
    ["kind", { kind: WagerTransactionKind.WIN }],
    ["reference", { referenceExternalTransactionId: "external-reference" }],
  ] as const)("changes the hash when business field %s changes", (_field, change) => {
    expect(
      hashWagerTransactionBusinessPayload({ ...payload(), ...change }),
    ).not.toBe(hashWagerTransactionBusinessPayload(payload()));
  });

  test("normalizes an omitted reference and null reference identically", () => {
    expect(hashWagerTransactionBusinessPayload(payload())).toBe(
      hashWagerTransactionBusinessPayload({
        ...payload(),
        referenceExternalTransactionId: null,
      }),
    );
    expect(hashWagerTransactionBusinessPayload(payload())).toBe(
      hashWagerTransactionBusinessPayload({
        ...payload(),
        referenceExternalTransactionId: undefined,
      }),
    );
  });

  test("excludes idempotency keys and transport metadata", () => {
    const withTransportMetadata = {
      ...payload(),
      idempotencyKey: "key-one",
      headers: { traceId: "trace-one" },
      messageId: "message-one",
      occurredAt: "2026-10-22T00:00:00.000Z",
    };
    expect(hashWagerTransactionBusinessPayload(withTransportMetadata)).toBe(
      hashWagerTransactionBusinessPayload(payload()),
    );
  });

  test("keeps amount as a string and returns lowercase SHA-256 hex", () => {
    const canonical = canonicalizeJson({ ...payload() });
    const hash = hashWagerTransactionBusinessPayload(payload());
    expect(canonical).toContain('"amount":"10.00"');
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  test("rejects amounts that do not satisfy the Money textual contract", () => {
    expect(() =>
      hashWagerTransactionBusinessPayload({
        ...payload(),
        money: { amount: "10.0", currency: "BRL" },
      }),
    ).toThrow();
  });

  test("preserves array order while canonicalizing object keys", () => {
    expect(canonicalizeJson({ second: 2, first: 1 })).toBe(
      '{"first":1,"second":2}',
    );
    expect(canonicalizeJson({ values: ["first", "second"] })).not.toBe(
      canonicalizeJson({ values: ["second", "first"] }),
    );
  });
});
