import { describe, expect, test } from "bun:test";
import { CurrencyMismatchError, Money } from "../src/shared/domain/money";
import { LedgerDirection } from "../src/wallet/domain/ledger-direction";
import {
  InsufficientFundsError,
  InvalidWalletOperationError,
  InvalidWalletStateError,
  Wallet,
  type WalletState,
} from "../src/wallet/domain/wallet";
import { WalletLedgerEntry } from "../src/wallet/domain/wallet-ledger-entry";

const openedAt = "2026-01-01T10:00:00.000Z";
const creditedAt = "2026-01-01T10:01:00.000Z";
const debitedAt = "2026-01-01T10:02:00.000Z";

function money(amount: string, currency = "BRL"): Money {
  return Money.from({ amount, currency });
}

function props() {
  return {
    id: "wallet-1",
    playerId: "player-1",
    currency: "BRL",
    balance: money("10.00"),
  };
}

function state(): WalletState {
  return {
    ...props(),
    version: 7,
    createdAt: new Date(openedAt),
    updatedAt: new Date(creditedAt),
  };
}

function snapshot(wallet: Wallet) {
  return {
    id: wallet.id,
    playerId: wallet.playerId,
    currency: wallet.currency,
    balance: wallet.balance,
    version: wallet.version,
    createdAt: wallet.createdAt,
    updatedAt: wallet.updatedAt,
  };
}

describe("Wallet creation", () => {
  test("accepts the maximum persistable balance and rejects larger balances", () => {
    const maximum = money("999999999999999999.99");
    const oversized = money("1000000000000000000.00");
    expect(Wallet.open({ ...props(), balance: maximum }).balance).toBe(maximum);
    expect(() => Wallet.open({ ...props(), balance: oversized })).toThrow(
      InvalidWalletStateError,
    );
    expect(() => Wallet.rehydrate({ ...state(), balance: oversized })).toThrow(
      InvalidWalletStateError,
    );
  });

  test("rejects an overflowing credit without changing wallet state", () => {
    const wallet = Wallet.open(
      { ...props(), balance: money("999999999999999999.99") },
      new Date(openedAt),
    );
    const before = snapshot(wallet);
    expect(() => wallet.credit(money("0.01"), new Date(creditedAt))).toThrow(
      InvalidWalletOperationError,
    );
    expect(snapshot(wallet)).toEqual(before);
  });

  test("opens a wallet with the supplied identity, balance and timestamps", () => {
    const input = props();
    const wallet = Wallet.open(input, new Date(openedAt));
    expect(snapshot(wallet)).toEqual({
      ...input,
      version: 1,
      createdAt: new Date(openedAt),
      updatedAt: new Date(openedAt),
    });
  });

  test.each([
    "0.00",
    "0.01",
    "100.00",
  ])("accepts the non-negative initial balance %s", (amount) => {
    const wallet = Wallet.open({ ...props(), balance: money(amount) });
    expect(wallet.balance.toString()).toBe(`${amount} BRL`);
    expect(wallet.version).toBe(1);
  });

  test("defines timestamps when no explicit timestamp is supplied", () => {
    const before = Date.now();
    const wallet = Wallet.open(props());
    expect(wallet.createdAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(wallet.createdAt.getTime()).toBeLessThanOrEqual(Date.now());
    expect(wallet.updatedAt).toEqual(wallet.createdAt);
  });

  test("rejects negative initial balances", () => {
    expect(() =>
      Wallet.open({ ...props(), balance: money("0.01").negate() }),
    ).toThrow(InvalidWalletStateError);
  });

  test("rejects an initial currency mismatch", () => {
    expect(() => Wallet.open({ ...props(), currency: "USD" })).toThrow(
      CurrencyMismatchError,
    );
  });

  test.each([
    "id",
    "playerId",
  ] as const)("rejects an empty or whitespace-only %s", (field) => {
    for (const value of ["", " ", "\t\n"]) {
      expect(() => Wallet.open({ ...props(), [field]: value })).toThrow(
        InvalidWalletStateError,
      );
    }
  });

  test("rejects an invalid creation timestamp", () => {
    expect(() => Wallet.open(props(), new Date("invalid"))).toThrow(
      InvalidWalletStateError,
    );
  });

  test("supports currencies other than BRL", () => {
    const wallet = Wallet.open(
      { ...props(), currency: "EUR", balance: money("10.00", "EUR") },
      new Date(openedAt),
    );
    expect(
      wallet
        .credit(money("5.00", "EUR"), new Date(creditedAt))
        .balanceAfter.toString(),
    ).toBe("15.00 EUR");
  });
});

describe("Wallet rehydration", () => {
  test("restores all persisted state without incrementing the version", () => {
    const input = state();
    const wallet = Wallet.rehydrate(input);
    expect(snapshot(wallet)).toEqual(input);
    expect(wallet.version).toBe(7);
    wallet.credit(money("1.00"), new Date(debitedAt));
    expect(wallet.version).toBe(8);
  });

  test.each([
    0,
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
  ])("rejects the invalid persisted version %s", (version) => {
    expect(() => Wallet.rehydrate({ ...state(), version })).toThrow(
      InvalidWalletStateError,
    );
  });

  test("rejects negative persisted balances", () => {
    expect(() =>
      Wallet.rehydrate({ ...state(), balance: money("1.00").negate() }),
    ).toThrow(InvalidWalletStateError);
  });

  test("rejects persisted currency mismatches", () => {
    expect(() => Wallet.rehydrate({ ...state(), currency: "USD" })).toThrow(
      CurrencyMismatchError,
    );
  });

  test.each([
    "id",
    "playerId",
  ] as const)("rejects an empty persisted %s", (field) => {
    expect(() => Wallet.rehydrate({ ...state(), [field]: "" })).toThrow(
      InvalidWalletStateError,
    );
  });

  test.each([
    "createdAt",
    "updatedAt",
  ] as const)("rejects an invalid persisted %s", (field) => {
    expect(() =>
      Wallet.rehydrate({ ...state(), [field]: new Date("invalid") }),
    ).toThrow(InvalidWalletStateError);
  });

  test("rejects updatedAt preceding createdAt", () => {
    expect(() =>
      Wallet.rehydrate({ ...state(), createdAt: new Date(debitedAt) }),
    ).toThrow(InvalidWalletStateError);
  });
});

describe("Wallet credit and debit", () => {
  test("credits exactly and returns immutable ledger data", () => {
    const wallet = Wallet.open(
      { ...props(), balance: money("0.10") },
      new Date(openedAt),
    );
    const amount = money("0.20");
    const before = wallet.balance;
    const change = wallet.credit(amount, new Date(creditedAt));
    expect(change).toEqual({
      balanceBefore: before,
      balanceAfter: wallet.balance,
      amount,
      direction: LedgerDirection.CREDIT,
    });
    expect(change.balanceBefore.toString()).toBe("0.10 BRL");
    expect(change.balanceAfter.toString()).toBe("0.30 BRL");
    expect(change.amount).toBe(amount);
    expect(wallet.version).toBe(2);
    expect(wallet.updatedAt).toEqual(new Date(creditedAt));
    expect(wallet.createdAt).toEqual(new Date(openedAt));
    expect(Object.isFrozen(change)).toBe(true);
    expect(Reflect.set(change, "direction", LedgerDirection.DEBIT)).toBe(false);
  });

  test("debits exactly and reports balances and direction", () => {
    const wallet = Wallet.open(
      { ...props(), balance: money("0.30") },
      new Date(openedAt),
    );
    const amount = money("0.20");
    const change = wallet.debit(amount, new Date(debitedAt));
    expect(change.direction).toBe(LedgerDirection.DEBIT);
    expect(change.amount).toBe(amount);
    expect(change.balanceBefore.toString()).toBe("0.30 BRL");
    expect(change.balanceAfter.toString()).toBe("0.10 BRL");
    expect(wallet.balance).toBe(change.balanceAfter);
    expect(wallet.version).toBe(2);
    expect(wallet.updatedAt).toEqual(new Date(debitedAt));
    expect(Object.isFrozen(change)).toBe(true);
  });

  test("allows exact depletion to zero", () => {
    const wallet = Wallet.open(props(), new Date(openedAt));
    const change = wallet.debit(money("10.00"), new Date(debitedAt));
    expect(change.balanceAfter.toString()).toBe("0.00 BRL");
    expect(wallet.balance.isZero()).toBe(true);
    expect(wallet.version).toBe(2);
  });

  test("rejects insufficient funds without changing any state", () => {
    const wallet = Wallet.open(props(), new Date(openedAt));
    const before = snapshot(wallet);
    expect(() => wallet.debit(money("10.01"), new Date(debitedAt))).toThrow(
      InsufficientFundsError,
    );
    expect(snapshot(wallet)).toEqual(before);
    expect(wallet.balance).toBe(before.balance);
  });

  test.each([
    "credit",
    "debit",
  ] as const)("rejects zero in %s without changing state", (operation) => {
    const wallet = Wallet.open(props(), new Date(openedAt));
    const before = snapshot(wallet);
    expect(() =>
      wallet[operation](Money.zero("BRL"), new Date(creditedAt)),
    ).toThrow(InvalidWalletOperationError);
    expect(snapshot(wallet)).toEqual(before);
  });

  test.each([
    "credit",
    "debit",
  ] as const)("rejects internal negative Money in %s without changing state", (operation) => {
    const wallet = Wallet.open(props(), new Date(openedAt));
    const before = snapshot(wallet);
    expect(() =>
      wallet[operation](money("1.00").negate(), new Date(creditedAt)),
    ).toThrow(InvalidWalletOperationError);
    expect(snapshot(wallet)).toEqual(before);
  });

  test.each([
    "credit",
    "debit",
  ] as const)("rejects currency mismatches in %s without changing state", (operation) => {
    const wallet = Wallet.open(props(), new Date(openedAt));
    const before = snapshot(wallet);
    expect(() =>
      wallet[operation](money("1.00", "USD"), new Date(creditedAt)),
    ).toThrow(CurrencyMismatchError);
    expect(snapshot(wallet)).toEqual(before);
  });

  test.each([
    "credit",
    "debit",
  ] as const)("rejects invalid timestamps in %s without changing state", (operation) => {
    const wallet = Wallet.open(props(), new Date(openedAt));
    const before = snapshot(wallet);
    expect(() => wallet[operation](money("1.00"), new Date("invalid"))).toThrow(
      InvalidWalletOperationError,
    );
    expect(snapshot(wallet)).toEqual(before);
  });

  test.each([
    "credit",
    "debit",
  ] as const)("rejects timestamps going backward in %s without changing state", (operation) => {
    const wallet = Wallet.rehydrate(state());
    const before = snapshot(wallet);
    expect(() => wallet[operation](money("1.00"), new Date(openedAt))).toThrow(
      InvalidWalletOperationError,
    );
    expect(snapshot(wallet)).toEqual(before);
  });

  test.each([
    "credit",
    "debit",
  ] as const)("prevents version overflow during %s without changing state", (operation) => {
    const wallet = Wallet.rehydrate({
      ...state(),
      version: Number.MAX_SAFE_INTEGER,
    });
    const before = snapshot(wallet);
    expect(() => wallet[operation](money("1.00"), new Date(debitedAt))).toThrow(
      InvalidWalletOperationError,
    );
    expect(snapshot(wallet)).toEqual(before);
  });

  test("increments the version exactly once per mutation and never on failure", () => {
    const wallet = Wallet.open(props(), new Date(openedAt));
    expect(wallet.version).toBe(1);
    wallet.credit(money("5.00"), new Date(creditedAt));
    expect(wallet.version).toBe(2);
    const beforeFailure = snapshot(wallet);
    expect(() => wallet.debit(money("15.01"), new Date(debitedAt))).toThrow(
      InsufficientFundsError,
    );
    expect(snapshot(wallet)).toEqual(beforeFailure);
    wallet.debit(money("2.00"), new Date(debitedAt));
    expect(wallet.version).toBe(3);
    expect(wallet.balance.toString()).toBe("13.00 BRL");
  });

  test("preserves precision near the maximum persistable balance", () => {
    const wallet = Wallet.open(
      { ...props(), balance: money("999999999999999999.97") },
      new Date(openedAt),
    );
    wallet.credit(money("0.01"), new Date(creditedAt));
    expect(wallet.balance.toString()).toBe("999999999999999999.98 BRL");
    wallet.debit(money("0.02"), new Date(debitedAt));
    expect(wallet.balance.toString()).toBe("999999999999999999.96 BRL");
  });

  test("provides enough data to construct either ledger direction", () => {
    const wallet = Wallet.open(props(), new Date(openedAt));
    for (const operation of ["credit", "debit"] as const) {
      const change = wallet[operation](money("1.00"), new Date(creditedAt));
      const entry = WalletLedgerEntry.create(
        {
          id: `entry-${operation}`,
          walletId: wallet.id,
          transactionId: `transaction-${operation}`,
          direction: change.direction,
          money: change.amount,
          balanceBefore: change.balanceBefore,
          balanceAfter: change.balanceAfter,
        },
        new Date(creditedAt),
      );
      expect(entry.balanceAfter.equals(wallet.balance)).toBe(true);
    }
  });

  test("keeps previous mutation results stable after subsequent operations", () => {
    const wallet = Wallet.open(props(), new Date(openedAt));
    const first = wallet.credit(money("5.00"), new Date(creditedAt));
    wallet.debit(money("2.00"), new Date(debitedAt));
    expect(first.balanceBefore.toString()).toBe("10.00 BRL");
    expect(first.balanceAfter.toString()).toBe("15.00 BRL");
    expect(wallet.balance.toString()).toBe("13.00 BRL");
  });

  test("uses current timestamps when operation timestamps are omitted", () => {
    const wallet = Wallet.open(props(), new Date(openedAt));
    wallet.credit(money("1.00"));
    expect(wallet.updatedAt.getTime()).toBeGreaterThan(
      new Date(openedAt).getTime(),
    );
    wallet.debit(money("1.00"));
    expect(wallet.version).toBe(3);
  });
});

describe("Wallet state encapsulation", () => {
  test("protects identity and financial state against arbitrary public writes", () => {
    const wallet = Wallet.open(props(), new Date(openedAt));
    const before = snapshot(wallet);
    for (const field of [
      "id",
      "playerId",
      "currency",
      "balance",
      "version",
      "createdAt",
      "updatedAt",
    ]) {
      expect(Reflect.set(wallet, field, "invalid")).toBe(false);
    }
    expect(() =>
      Object.defineProperty(wallet, "version", { value: 99 }),
    ).toThrow(TypeError);
    expect(snapshot(wallet)).toEqual(before);
  });

  test("copies timestamps at creation, mutation and access boundaries", () => {
    const at = new Date(openedAt);
    const wallet = Wallet.open(props(), at);
    at.setUTCFullYear(2000);
    wallet.createdAt.setUTCFullYear(2000);
    wallet.updatedAt.setUTCFullYear(2000);
    expect(wallet.createdAt).toEqual(new Date(openedAt));
    expect(wallet.updatedAt).toEqual(new Date(openedAt));
    const mutationAt = new Date(creditedAt);
    wallet.credit(money("1.00"), mutationAt);
    mutationAt.setUTCFullYear(2000);
    wallet.updatedAt.setUTCFullYear(2000);
    expect(wallet.updatedAt).toEqual(new Date(creditedAt));
  });

  test("does not retain mutable rehydration properties", () => {
    const input = state();
    const wallet = Wallet.rehydrate(input);
    input.balance = money("99.00");
    input.version = 99;
    input.createdAt.setUTCFullYear(2000);
    input.updatedAt.setUTCFullYear(2000);
    expect(wallet.balance.toString()).toBe("10.00 BRL");
    expect(wallet.version).toBe(7);
    expect(wallet.createdAt).toEqual(new Date(openedAt));
    expect(wallet.updatedAt).toEqual(new Date(creditedAt));
  });
});
