import Decimal from "decimal.js";

export interface MoneyProps {
  amount: string;
  currency: string;
}

export class InvalidMoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidMoneyError";
  }
}

export class CurrencyMismatchError extends Error {
  constructor(expected: string, received: string) {
    super(`Currency mismatch: expected ${expected}, received ${received}`);
    this.name = "CurrencyMismatchError";
  }
}

const MoneyDecimal = Decimal.clone();

export class Money {
  readonly #value: Decimal;
  public readonly currency: string;

  private constructor(value: Decimal, currency: string) {
    this.#value = value;
    this.currency = currency;
    Object.freeze(this);
  }

  static from({ amount, currency }: MoneyProps): Money {
    if (
      typeof amount !== "string" ||
      amount.trim() !== amount ||
      !/^[0-9]+\.[0-9]{2}$/.test(amount)
    ) {
      throw new InvalidMoneyError(
        "Amount must be a non-negative decimal string with exactly two decimal places",
      );
    }
    if (
      typeof currency !== "string" ||
      !/^[A-Z]{3}$/.test(currency) ||
      currency.length !== 3
    ) {
      throw new InvalidMoneyError(
        "Currency must be a three-letter uppercase ISO-4217 code",
      );
    }
    return new Money(new MoneyDecimal(amount), currency);
  }

  static zero(currency: string): Money {
    return Money.from({ amount: "0.00", currency });
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(
      this.decimalForOperation(other).plus(other.#value),
      this.currency,
    );
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(
      this.decimalForOperation(other).minus(other.#value),
      this.currency,
    );
  }

  negate(): Money {
    return new Money(this.#value.negated(), this.currency);
  }

  isZero(): boolean {
    return this.#value.isZero();
  }

  isPositive(): boolean {
    return this.#value.greaterThan("0");
  }

  isNegative(): boolean {
    return this.#value.lessThan("0");
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.#value.lessThan(other.#value);
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.#value.equals(other.#value);
  }

  toJSON(): MoneyProps {
    return {
      amount: this.isZero() ? "0.00" : this.#value.toFixed(2),
      currency: this.currency,
    };
  }

  toString(): string {
    return `${this.toJSON().amount} ${this.currency}`;
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new CurrencyMismatchError(this.currency, other.currency);
    }
  }

  private decimalForOperation(other: Money): Decimal {
    // Include fractional digits and room for a carry beyond either operand.
    const precision =
      Math.max(this.#value.toFixed(2).length, other.#value.toFixed(2).length) +
      1;
    const ExactDecimal = MoneyDecimal.clone({ precision });
    return new ExactDecimal(this.#value);
  }
}
