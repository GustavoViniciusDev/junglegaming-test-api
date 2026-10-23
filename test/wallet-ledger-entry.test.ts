import { describe, expect, test } from "bun:test";
import { CurrencyMismatchError, Money } from "../src/shared/domain/money";
import { LedgerDirection } from "../src/wallet/domain/ledger-direction";
import {
  type CreateWalletLedgerEntryProps,
  InvalidLedgerEntryError,
  WalletLedgerEntry,
  type WalletLedgerEntryState,
} from "../src/wallet/domain/wallet-ledger-entry";

const createdAt = "2026-01-01T10:00:00.000Z";

function money(amount: string, currency = "BRL"): Money {
  return Money.from({ amount, currency });
}

function props(
  direction = LedgerDirection.CREDIT,
): CreateWalletLedgerEntryProps {
  return {
    id: "entry-1",
    walletId: "wallet-1",
    transactionId: "transaction-1",
    direction,
    money: money("20.00"),
    balanceBefore: money("100.00"),
    balanceAfter: money(
      direction === LedgerDirection.CREDIT ? "120.00" : "80.00",
    ),
  };
}

function state(direction = LedgerDirection.CREDIT): WalletLedgerEntryState {
  return { ...props(direction), createdAt: new Date(createdAt) };
}

function snapshot(entry: WalletLedgerEntry) {
  return {
    id: entry.id,
    walletId: entry.walletId,
    transactionId: entry.transactionId,
    direction: entry.direction,
    money: entry.money,
    balanceBefore: entry.balanceBefore,
    balanceAfter: entry.balanceAfter,
    createdAt: entry.createdAt,
  };
}

describe("WalletLedgerEntry creation", () => {
  test("accepts the maximum persistable balance and amount", () => {
    const maximum = money("999999999999999999.99");
    const entry = WalletLedgerEntry.create({
      ...props(),
      money: maximum,
      balanceBefore: Money.zero("BRL"),
      balanceAfter: maximum,
    });
    expect(entry.money).toBe(maximum);
    expect(entry.balanceAfter).toBe(maximum);
  });

  test("rejects an oversized amount or either oversized balance", () => {
    const oversized = money("1000000000000000000.00");
    expect(() =>
      WalletLedgerEntry.create({
        ...props(),
        money: oversized,
        balanceBefore: Money.zero("BRL"),
        balanceAfter: oversized,
      }),
    ).toThrow(InvalidLedgerEntryError);
    expect(() =>
      WalletLedgerEntry.create({
        ...props(LedgerDirection.DEBIT),
        money: money("0.01"),
        balanceBefore: oversized,
        balanceAfter: money("999999999999999999.99"),
      }),
    ).toThrow(InvalidLedgerEntryError);
    expect(() =>
      WalletLedgerEntry.create({
        ...props(),
        money: money("0.01"),
        balanceBefore: money("999999999999999999.99"),
        balanceAfter: oversized,
      }),
    ).toThrow(InvalidLedgerEntryError);
    expect(() =>
      WalletLedgerEntry.rehydrate({
        ...state(),
        money: oversized,
        balanceBefore: Money.zero("BRL"),
        balanceAfter: oversized,
      }),
    ).toThrow(InvalidLedgerEntryError);
  });

  test("accepts an exact CREDIT and exposes all supplied state", () => {
    const input = props();
    const entry = WalletLedgerEntry.create(input, new Date(createdAt));
    expect(snapshot(entry)).toEqual({
      ...input,
      createdAt: new Date(createdAt),
    });
    expect(entry.balanceBefore.toString()).toBe("100.00 BRL");
    expect(entry.money.toString()).toBe("20.00 BRL");
    expect(entry.balanceAfter.toString()).toBe("120.00 BRL");
  });

  test("accepts an exact DEBIT", () => {
    const entry = WalletLedgerEntry.create(props(LedgerDirection.DEBIT));
    expect(entry.direction).toBe(LedgerDirection.DEBIT);
    expect(entry.balanceAfter.toString()).toBe("80.00 BRL");
  });

  test("rejects an incorrect CREDIT balance", () => {
    expect(() =>
      WalletLedgerEntry.create({ ...props(), balanceAfter: money("119.99") }),
    ).toThrow(InvalidLedgerEntryError);
  });

  test("rejects an incorrect DEBIT balance", () => {
    expect(() =>
      WalletLedgerEntry.create({
        ...props(LedgerDirection.DEBIT),
        balanceAfter: money("80.01"),
      }),
    ).toThrow(InvalidLedgerEntryError);
  });

  test("accepts a CREDIT starting from zero", () => {
    const entry = WalletLedgerEntry.create({
      ...props(),
      balanceBefore: Money.zero("BRL"),
      balanceAfter: money("20.00"),
    });
    expect(entry.balanceBefore.isZero()).toBe(true);
    expect(entry.balanceAfter.toString()).toBe("20.00 BRL");
  });

  test("accepts a DEBIT depleting the balance exactly", () => {
    const entry = WalletLedgerEntry.create({
      ...props(LedgerDirection.DEBIT),
      money: money("100.00"),
      balanceAfter: Money.zero("BRL"),
    });
    expect(entry.balanceAfter.isZero()).toBe(true);
  });

  test.each([
    LedgerDirection.CREDIT,
    LedgerDirection.DEBIT,
  ])("rejects zero money for %s", (direction) => {
    expect(() =>
      WalletLedgerEntry.create({
        ...props(direction),
        money: Money.zero("BRL"),
        balanceAfter: money("100.00"),
      }),
    ).toThrow(InvalidLedgerEntryError);
  });

  test.each([
    LedgerDirection.CREDIT,
    LedgerDirection.DEBIT,
  ])("rejects negative money for %s", (direction) => {
    expect(() =>
      WalletLedgerEntry.create({
        ...props(direction),
        money: money("20.00").negate(),
      }),
    ).toThrow(InvalidLedgerEntryError);
  });

  test.each([
    "money",
    "balanceBefore",
    "balanceAfter",
  ] as const)("rejects a currency mismatch in %s", (field) => {
    expect(() =>
      WalletLedgerEntry.create({ ...props(), [field]: money("20.00", "USD") }),
    ).toThrow(CurrencyMismatchError);
  });

  test("rejects a negative balanceBefore even when the equation is correct", () => {
    expect(() =>
      WalletLedgerEntry.create({
        ...props(),
        balanceBefore: money("10.00").negate(),
        balanceAfter: money("10.00"),
      }),
    ).toThrow(InvalidLedgerEntryError);
  });

  test("rejects a negative balanceAfter even when the equation is correct", () => {
    expect(() =>
      WalletLedgerEntry.create({
        ...props(LedgerDirection.DEBIT),
        money: money("120.00"),
        balanceAfter: money("20.00").negate(),
      }),
    ).toThrow(InvalidLedgerEntryError);
  });

  test.each([
    "id",
    "walletId",
    "transactionId",
  ] as const)("rejects an empty or whitespace-only %s", (field) => {
    for (const value of ["", " ", "\t\n"]) {
      expect(() =>
        WalletLedgerEntry.create({ ...props(), [field]: value }),
      ).toThrow(InvalidLedgerEntryError);
    }
  });

  test("rejects unsupported runtime directions", () => {
    for (const direction of ["", "credit", "TRANSFER"]) {
      const input = { ...props(), direction };
      // @ts-expect-error Unsupported directions must also be rejected at runtime.
      expect(() => WalletLedgerEntry.create(input)).toThrow(
        InvalidLedgerEntryError,
      );
    }
  });

  test("rejects an invalid creation timestamp", () => {
    expect(() =>
      WalletLedgerEntry.create(props(), new Date("invalid")),
    ).toThrow(InvalidLedgerEntryError);
  });

  test("defines a current creation timestamp when none is supplied", () => {
    const before = Date.now();
    const entry = WalletLedgerEntry.create(props());
    expect(entry.createdAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(entry.createdAt.getTime()).toBeLessThanOrEqual(Date.now());
  });

  test("supports another currency when all monetary values match", () => {
    const entry = WalletLedgerEntry.create({
      ...props(),
      money: money("20.00", "EUR"),
      balanceBefore: money("100.00", "EUR"),
      balanceAfter: money("120.00", "EUR"),
    });
    expect(entry.money.currency).toBe("EUR");
  });

  test("validates exact fractional CREDIT arithmetic", () => {
    const entry = WalletLedgerEntry.create({
      ...props(),
      money: money("0.20"),
      balanceBefore: money("0.10"),
      balanceAfter: money("0.30"),
    });
    expect(entry.balanceAfter.toString()).toBe("0.30 BRL");
  });

  test("validates exact fractional DEBIT arithmetic", () => {
    const entry = WalletLedgerEntry.create({
      ...props(LedgerDirection.DEBIT),
      money: money("0.20"),
      balanceBefore: money("0.30"),
      balanceAfter: money("0.10"),
    });
    expect(entry.balanceAfter.toString()).toBe("0.10 BRL");
  });

  test("validates balances near the persistable limit without loss of precision", () => {
    const entry = WalletLedgerEntry.create({
      ...props(),
      money: money("0.01"),
      balanceBefore: money("999999999999999999.98"),
      balanceAfter: money("999999999999999999.99"),
    });
    expect(entry.balanceAfter.toString()).toBe("999999999999999999.99 BRL");
  });
});

describe("WalletLedgerEntry rehydration", () => {
  test.each([
    LedgerDirection.CREDIT,
    LedgerDirection.DEBIT,
  ])("restores every persisted field for %s", (direction) => {
    const input = state(direction);
    const entry = WalletLedgerEntry.rehydrate(input);
    expect(snapshot(entry)).toEqual(input);
    expect(entry.money).toBe(input.money);
    expect(entry.balanceBefore).toBe(input.balanceBefore);
    expect(entry.balanceAfter).toBe(input.balanceAfter);
  });

  test.each([
    "id",
    "walletId",
    "transactionId",
  ] as const)("rejects an empty persisted %s", (field) => {
    expect(() =>
      WalletLedgerEntry.rehydrate({ ...state(), [field]: "" }),
    ).toThrow(InvalidLedgerEntryError);
  });

  test("rejects a persisted zero amount", () => {
    expect(() =>
      WalletLedgerEntry.rehydrate({ ...state(), money: Money.zero("BRL") }),
    ).toThrow(InvalidLedgerEntryError);
  });

  test("rejects a persisted negative amount", () => {
    expect(() =>
      WalletLedgerEntry.rehydrate({
        ...state(),
        money: money("20.00").negate(),
      }),
    ).toThrow(InvalidLedgerEntryError);
  });

  test.each([
    "balanceBefore",
    "balanceAfter",
  ] as const)("rejects a negative persisted %s", (field) => {
    expect(() =>
      WalletLedgerEntry.rehydrate({
        ...state(),
        [field]: money("1.00").negate(),
      }),
    ).toThrow(InvalidLedgerEntryError);
  });

  test.each([
    "money",
    "balanceBefore",
    "balanceAfter",
  ] as const)("rejects a persisted currency mismatch in %s", (field) => {
    expect(() =>
      WalletLedgerEntry.rehydrate({
        ...state(),
        [field]: money("20.00", "USD"),
      }),
    ).toThrow(CurrencyMismatchError);
  });

  test.each([
    LedgerDirection.CREDIT,
    LedgerDirection.DEBIT,
  ])("rejects an inconsistent stored equation for %s", (direction) => {
    expect(() =>
      WalletLedgerEntry.rehydrate({
        ...state(direction),
        balanceAfter: money("99.99"),
      }),
    ).toThrow(InvalidLedgerEntryError);
  });

  test("rejects an unsupported persisted direction", () => {
    const input = { ...state(), direction: "INVALID" };
    // @ts-expect-error Persisted data may violate the typed direction contract.
    expect(() => WalletLedgerEntry.rehydrate(input)).toThrow(
      InvalidLedgerEntryError,
    );
  });

  test("rejects an invalid persisted creation timestamp", () => {
    expect(() =>
      WalletLedgerEntry.rehydrate({
        ...state(),
        createdAt: new Date("invalid"),
      }),
    ).toThrow(InvalidLedgerEntryError);
  });
});

describe("WalletLedgerEntry immutability", () => {
  test.each([
    "create",
    "rehydrate",
  ] as const)("protects every exposed field after %s", (factory) => {
    const entry =
      factory === "create"
        ? WalletLedgerEntry.create(props(), new Date(createdAt))
        : WalletLedgerEntry.rehydrate(state());
    const before = snapshot(entry);
    expect(Object.isFrozen(entry)).toBe(true);
    expect(Reflect.deleteProperty(entry, "money")).toBe(false);
    for (const field of [
      "id",
      "walletId",
      "transactionId",
      "direction",
      "money",
      "balanceBefore",
      "balanceAfter",
      "createdAt",
    ]) {
      expect(Reflect.set(entry, field, "invalid")).toBe(false);
    }
    expect(() =>
      Object.defineProperty(entry, "money", { value: money("99.00") }),
    ).toThrow(TypeError);
    expect(snapshot(entry)).toEqual(before);
  });

  test.each([
    "create",
    "rehydrate",
  ] as const)("copies Date values at input and output boundaries during %s", (factory) => {
    const input = state();
    const entry =
      factory === "create"
        ? WalletLedgerEntry.create(input, input.createdAt)
        : WalletLedgerEntry.rehydrate(input);
    input.createdAt.setUTCFullYear(2000);
    entry.createdAt.setUTCFullYear(2000);
    expect(entry.createdAt).toEqual(new Date(createdAt));
  });

  test("does not retain a mutable properties object", () => {
    const input = state();
    const entry = WalletLedgerEntry.rehydrate(input);
    input.id = "another-entry";
    input.walletId = "another-wallet";
    input.transactionId = "another-transaction";
    input.money = money("99.00");
    input.balanceBefore = money("0.00");
    input.balanceAfter = money("0.00");
    input.direction = LedgerDirection.DEBIT;
    expect(snapshot(entry)).toEqual(state());
  });

  test("keeps Money values immutable when performing calculations with exposed state", () => {
    const entry = WalletLedgerEntry.create(props(), new Date(createdAt));
    const before = snapshot(entry);
    entry.money.negate();
    entry.balanceBefore.add(money("1.00"));
    entry.balanceAfter.subtract(money("1.00"));
    expect(snapshot(entry)).toEqual(before);
  });
});
