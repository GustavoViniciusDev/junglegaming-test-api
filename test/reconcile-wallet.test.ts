import { describe, expect, test } from "bun:test";
import { Money } from "../src/shared/domain/money";
import { LedgerDirection } from "../src/wallet/domain/ledger-direction";
import {
  ReconcileWallet,
  reconstructLedger,
  type ReconciliationLedgerEntry,
} from "../src/wallet/application/reconcile-wallet";
import { Wallet } from "../src/wallet/domain/wallet";

function entry(
  direction: string,
  amount: string,
  before: string,
  after: string,
  currency = "BRL",
): ReconciliationLedgerEntry {
  return {
    direction,
    money: Money.from({ amount, currency }),
    balanceBefore: Money.from({ amount: before, currency }),
    balanceAfter: Money.from({ amount: after, currency }),
  };
}

describe("reconstructLedger", () => {
  test("returns zero for an empty ledger", () => {
    const result = reconstructLedger("BRL", []);
    expect(result.calculatedBalance.toJSON()).toEqual({
      amount: "0.00",
      currency: "BRL",
    });
    expect(result.chainConsistent).toBe(true);
    expect(result.checkedEntries).toBe(0);
  });

  test("reconstructs and validates a complete ledger chain", () => {
    const result = reconstructLedger("BRL", [
      entry(LedgerDirection.CREDIT, "100.00", "0.00", "100.00"),
      entry(LedgerDirection.DEBIT, "20.00", "100.00", "80.00"),
      entry(LedgerDirection.CREDIT, "30.00", "80.00", "110.00"),
    ]);
    expect(result.calculatedBalance.toJSON()).toEqual({
      amount: "110.00",
      currency: "BRL",
    });
    expect(result.chainConsistent).toBe(true);
    expect(result.checkedEntries).toBe(3);
  });

  test("detects broken chain, arithmetic, and currency without trusting snapshots", () => {
    const result = reconstructLedger("BRL", [
      entry(LedgerDirection.CREDIT, "10.00", "0.00", "9.00"),
      entry(LedgerDirection.DEBIT, "2.00", "9.00", "7.00"),
      entry(LedgerDirection.CREDIT, "1.00", "7.00", "8.00", "USD"),
    ]);
    expect(result.chainConsistent).toBe(false);
    expect(result.calculatedBalance.toJSON()).toEqual({
      amount: "8.00",
      currency: "BRL",
    });
    expect(result.checkedEntries).toBe(3);
  });

  test("reports a signed stored-minus-calculated difference", async () => {
    const wallet = Wallet.open({
      id: "wallet-reconciliation-test",
      playerId: "player-reconciliation-test",
      currency: "BRL",
      balance: Money.from({ amount: "125.00", currency: "BRL" }),
    });
    const useCase = new ReconcileWallet({
      loadSnapshot: async () => ({
        wallet,
        entries: [entry(LedgerDirection.CREDIT, "130.00", "0.00", "130.00")],
      }),
    });

    await expect(useCase.execute(wallet.id)).resolves.toMatchObject({
      difference: { amount: "-5.00", currency: "BRL" },
      consistent: false,
      checkedEntries: 1,
    });
  });
});
