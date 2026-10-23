import { CurrencyMismatchError, type Money } from "../../shared/domain/money";
import { isWithinPersistableMoneyRange } from "../../shared/domain/persistable-money-range";
import { LedgerDirection } from "./ledger-direction";

export class InvalidLedgerEntryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidLedgerEntryError";
  }
}

export interface CreateWalletLedgerEntryProps {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
}

export interface WalletLedgerEntryState extends CreateWalletLedgerEntryProps {
  createdAt: Date;
}

export class WalletLedgerEntry {
  public readonly id: string;
  public readonly walletId: string;
  public readonly transactionId: string;
  public readonly direction: LedgerDirection;
  public readonly money: Money;
  public readonly balanceBefore: Money;
  public readonly balanceAfter: Money;
  readonly #createdAt: Date;

  private constructor(props: WalletLedgerEntryState) {
    if (
      !props.id.trim() ||
      !props.walletId.trim() ||
      !props.transactionId.trim()
    ) {
      throw new InvalidLedgerEntryError(
        "Ledger id, wallet id and transaction id must not be empty",
      );
    }
    if (
      props.direction !== LedgerDirection.CREDIT &&
      props.direction !== LedgerDirection.DEBIT
    ) {
      throw new InvalidLedgerEntryError(
        "Ledger direction must be CREDIT or DEBIT",
      );
    }
    if (!props.money.isPositive()) {
      throw new InvalidLedgerEntryError(
        "Ledger money must be strictly positive",
      );
    }
    if (!isWithinPersistableMoneyRange(props.money)) {
      throw new InvalidLedgerEntryError(
        "Ledger money exceeds the persistable monetary range",
      );
    }
    for (const balance of [props.balanceBefore, props.balanceAfter]) {
      if (balance.currency !== props.money.currency) {
        throw new CurrencyMismatchError(props.money.currency, balance.currency);
      }
      if (balance.isNegative()) {
        throw new InvalidLedgerEntryError(
          "Ledger balances must not be negative",
        );
      }
      if (!isWithinPersistableMoneyRange(balance)) {
        throw new InvalidLedgerEntryError(
          "Ledger balance exceeds the persistable monetary range",
        );
      }
    }
    const expectedBalance =
      props.direction === LedgerDirection.CREDIT
        ? props.balanceBefore.add(props.money)
        : props.balanceBefore.subtract(props.money);
    if (!expectedBalance.equals(props.balanceAfter)) {
      throw new InvalidLedgerEntryError(
        "Ledger balances do not match the direction and money",
      );
    }
    if (!Number.isFinite(props.createdAt.getTime())) {
      throw new InvalidLedgerEntryError(
        "Ledger creation timestamp must be valid",
      );
    }
    this.id = props.id;
    this.walletId = props.walletId;
    this.transactionId = props.transactionId;
    this.direction = props.direction;
    this.money = props.money;
    this.balanceBefore = props.balanceBefore;
    this.balanceAfter = props.balanceAfter;
    this.#createdAt = new Date(props.createdAt.getTime());
    Object.freeze(this);
  }

  static create(
    props: CreateWalletLedgerEntryProps,
    at: Date = new Date(),
  ): WalletLedgerEntry {
    return new WalletLedgerEntry({ ...props, createdAt: at });
  }

  static rehydrate(state: WalletLedgerEntryState): WalletLedgerEntry {
    return new WalletLedgerEntry(state);
  }

  get createdAt(): Date {
    return new Date(this.#createdAt.getTime());
  }
}
