import {
  InvalidReadRequestError,
  ReadResourceNotFoundError,
} from "../../shared/application/read-errors";
import { Money, type MoneyProps } from "../../shared/domain/money";
import { LedgerDirection } from "../domain/ledger-direction";
import type { Wallet } from "../domain/wallet";

export interface ReconciliationLedgerEntry {
  direction: string;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
}

export interface WalletReconciliationSnapshot {
  wallet: Wallet;
  entries: readonly ReconciliationLedgerEntry[];
}

export interface WalletReconciliationStore {
  loadSnapshot(walletId: string): Promise<WalletReconciliationSnapshot | null>;
}

export interface WalletReconciliationResult {
  walletId: string;
  storedBalance: MoneyProps;
  calculatedBalance: MoneyProps;
  difference: MoneyProps;
  consistent: boolean;
  checkedEntries: number;
}

export function reconstructLedger(
  currency: string,
  entries: readonly ReconciliationLedgerEntry[],
): {
  calculatedBalance: Money;
  chainConsistent: boolean;
  checkedEntries: number;
} {
  let calculatedBalance = Money.zero(currency);
  let chainConsistent = true;

  for (const entry of entries) {
    if (
      entry.money.currency !== currency ||
      entry.balanceBefore.currency !== currency ||
      entry.balanceAfter.currency !== currency ||
      !entry.money.isPositive() ||
      entry.balanceBefore.isNegative() ||
      entry.balanceAfter.isNegative()
    ) {
      chainConsistent = false;
      continue;
    }

    const expectedBalance =
      entry.direction === LedgerDirection.CREDIT
        ? calculatedBalance.add(entry.money)
        : entry.direction === LedgerDirection.DEBIT
          ? calculatedBalance.subtract(entry.money)
          : null;

    if (
      expectedBalance === null ||
      !entry.balanceBefore.equals(calculatedBalance) ||
      !entry.balanceAfter.equals(expectedBalance)
    ) {
      chainConsistent = false;
    }

    if (expectedBalance !== null) calculatedBalance = expectedBalance;
  }

  return {
    calculatedBalance,
    chainConsistent,
    checkedEntries: entries.length,
  };
}

export class ReconcileWallet {
  constructor(private readonly store: WalletReconciliationStore) {}

  async execute(walletId: string): Promise<WalletReconciliationResult> {
    if (walletId.trim().length === 0) {
      throw new InvalidReadRequestError("Wallet id must not be empty");
    }

    const snapshot = await this.store.loadSnapshot(walletId);
    if (snapshot === null) throw new ReadResourceNotFoundError("Wallet");

    const { calculatedBalance, chainConsistent, checkedEntries } =
      reconstructLedger(snapshot.wallet.currency, snapshot.entries);
    const difference = snapshot.wallet.balance.subtract(calculatedBalance);

    return {
      walletId: snapshot.wallet.id,
      storedBalance: snapshot.wallet.balance.toJSON(),
      calculatedBalance: calculatedBalance.toJSON(),
      difference: difference.toJSON(),
      consistent:
        chainConsistent && snapshot.wallet.balance.equals(calculatedBalance),
      checkedEntries,
    };
  }
}
