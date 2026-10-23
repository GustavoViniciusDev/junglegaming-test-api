import { CurrencyMismatchError, type Money } from "../../shared/domain/money";
import { isWithinPersistableMoneyRange } from "../../shared/domain/persistable-money-range";
import { LedgerDirection } from "./ledger-direction";

export class InvalidWalletStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidWalletStateError";
  }
}

export class InvalidWalletOperationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidWalletOperationError";
  }
}

export class InsufficientFundsError extends Error {
  constructor() {
    super("Wallet has insufficient funds for the requested debit");
    this.name = "InsufficientFundsError";
  }
}

export interface OpenWalletProps {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
}

export interface WalletState extends OpenWalletProps {
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface WalletBalanceChange {
  readonly balanceBefore: Money;
  readonly balanceAfter: Money;
  readonly amount: Money;
  readonly direction: LedgerDirection;
}

export class Wallet {
  public readonly id: string;
  public readonly playerId: string;
  public readonly currency: string;
  readonly #createdAt: Date;
  #balance: Money;
  #version: number;
  #updatedAt: Date;

  private constructor(props: WalletState) {
    if (!props.id.trim() || !props.playerId.trim()) {
      throw new InvalidWalletStateError(
        "Wallet id and player id must not be empty",
      );
    }
    if (props.currency !== props.balance.currency) {
      throw new CurrencyMismatchError(props.currency, props.balance.currency);
    }
    if (props.balance.isNegative()) {
      throw new InvalidWalletStateError("Wallet balance must not be negative");
    }
    if (!isWithinPersistableMoneyRange(props.balance)) {
      throw new InvalidWalletStateError(
        "Wallet balance exceeds the persistable monetary range",
      );
    }
    if (!Number.isSafeInteger(props.version) || props.version < 1) {
      throw new InvalidWalletStateError(
        "Wallet version must be a positive safe integer",
      );
    }
    if (
      !Number.isFinite(props.createdAt.getTime()) ||
      !Number.isFinite(props.updatedAt.getTime()) ||
      props.updatedAt.getTime() < props.createdAt.getTime()
    ) {
      throw new InvalidWalletStateError(
        "Wallet timestamps must be valid and ordered",
      );
    }
    this.id = props.id;
    this.playerId = props.playerId;
    this.currency = props.currency;
    this.#balance = props.balance;
    this.#version = props.version;
    this.#createdAt = new Date(props.createdAt.getTime());
    this.#updatedAt = new Date(props.updatedAt.getTime());
    Object.freeze(this);
  }

  static open(props: OpenWalletProps, at: Date = new Date()): Wallet {
    return new Wallet({ ...props, version: 1, createdAt: at, updatedAt: at });
  }

  static rehydrate(state: WalletState): Wallet {
    return new Wallet(state);
  }

  get balance(): Money {
    return this.#balance;
  }

  get version(): number {
    return this.#version;
  }

  get createdAt(): Date {
    return new Date(this.#createdAt.getTime());
  }

  get updatedAt(): Date {
    return new Date(this.#updatedAt.getTime());
  }

  credit(amount: Money, at: Date = new Date()): WalletBalanceChange {
    return this.changeBalance(amount, LedgerDirection.CREDIT, at);
  }

  debit(amount: Money, at: Date = new Date()): WalletBalanceChange {
    return this.changeBalance(amount, LedgerDirection.DEBIT, at);
  }

  private changeBalance(
    amount: Money,
    direction: LedgerDirection,
    at: Date,
  ): WalletBalanceChange {
    if (this.currency !== amount.currency) {
      throw new CurrencyMismatchError(this.currency, amount.currency);
    }
    if (!amount.isPositive()) {
      throw new InvalidWalletOperationError(
        "Wallet operation amount must be strictly positive",
      );
    }
    if (this.#version === Number.MAX_SAFE_INTEGER) {
      throw new InvalidWalletOperationError(
        "Wallet version cannot be incremented safely",
      );
    }
    if (
      !Number.isFinite(at.getTime()) ||
      at.getTime() < this.#updatedAt.getTime()
    ) {
      throw new InvalidWalletOperationError(
        "Operation timestamp must be valid and not precede the wallet update",
      );
    }

    const balanceBefore = this.#balance;
    const balanceAfter =
      direction === LedgerDirection.CREDIT
        ? balanceBefore.add(amount)
        : balanceBefore.subtract(amount);
    if (balanceAfter.isNegative()) {
      throw new InsufficientFundsError();
    }
    if (!isWithinPersistableMoneyRange(balanceAfter)) {
      throw new InvalidWalletOperationError(
        "Wallet balance exceeds the persistable monetary range",
      );
    }
    const updatedAt = new Date(at.getTime());
    const change = Object.freeze({
      balanceBefore,
      balanceAfter,
      amount,
      direction,
    });
    this.#balance = balanceAfter;
    this.#version += 1;
    this.#updatedAt = updatedAt;
    return change;
  }
}
