import { describe, expect, test } from "bun:test";
import {
  decodeLedgerCursor,
  encodeLedgerCursor,
  parseLedgerLimit,
} from "../src/shared/application/ledger-cursor";
import { InvalidReadRequestError } from "../src/shared/application/read-errors";

const cursor = {
  walletId: "wallet-1",
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  id: "ledger-1",
};

describe("ledger cursor", () => {
  test("round-trips the versioned wallet-scoped cursor", () => {
    const encoded = encodeLedgerCursor(cursor);
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeLedgerCursor(encoded, cursor.walletId)).toEqual(cursor);
  });

  test("rejects malformed, unsupported, non-canonical and extra cursor fields", () => {
    const invalidPayloads = [
      "not-json",
      JSON.stringify({
        ...cursor,
        v: 2,
        createdAt: cursor.createdAt.toISOString(),
      }),
      JSON.stringify({ ...cursor, v: 1, createdAt: "not-a-date" }),
      JSON.stringify({
        ...cursor,
        v: 1,
        createdAt: cursor.createdAt.toISOString(),
        id: " ",
      }),
      JSON.stringify({
        ...cursor,
        v: 1,
        createdAt: cursor.createdAt.toISOString(),
        unexpected: true,
      }),
    ];
    const invalidCursors = [
      "%%%",
      ...invalidPayloads.map((payload) =>
        Buffer.from(payload, "utf8").toString("base64url"),
      ),
    ];
    for (const value of invalidCursors) {
      expect(() => decodeLedgerCursor(value, cursor.walletId)).toThrow(
        InvalidReadRequestError,
      );
    }
    expect(() =>
      decodeLedgerCursor(encodeLedgerCursor(cursor), "other-wallet"),
    ).toThrow(InvalidReadRequestError);
  });

  test("defaults limit to 50 and enforces the inclusive range 1 through 100", () => {
    expect(parseLedgerLimit(undefined)).toBe(50);
    expect(parseLedgerLimit("1")).toBe(1);
    expect(parseLedgerLimit("100")).toBe(100);
    for (const value of ["0", "-1", "101", "1.5", "NaN", ""]) {
      expect(() => parseLedgerLimit(value)).toThrow(InvalidReadRequestError);
    }
  });
});
