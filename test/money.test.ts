import { describe, expect, test } from "bun:test";
import Decimal from "decimal.js";
import {
  CurrencyMismatchError,
  InvalidMoneyError,
  Money,
} from "../src/shared/domain/money";

function money(amount: string, currency = "BRL"): Money {
  return Money.from({ amount, currency });
}

describe("Money creation", () => {
  test.each([
    "0.00",
    "0.01",
    "1.00",
    "25.90",
    "1000.00",
    "999999999999.99",
    "123456789012345678901234567890.12",
  ])("accepts the exact amount %s", (amount) => {
    expect(money(amount).toJSON()).toEqual({ amount, currency: "BRL" });
  });

  test.each(["BRL", "USD", "EUR"])("accepts currency %s", (currency) => {
    expect(money("25.00", currency).currency).toBe(currency);
    expect(Money.zero(currency).toJSON()).toEqual({ amount: "0.00", currency });
  });

  test("normalizes leading zeros without changing the value", () => {
    expect(money("00025.90").toString()).toBe("25.90 BRL");
    expect(money("000.00").toString()).toBe("0.00 BRL");
  });

  test.each([
    "",
    " ",
    "NaN",
    "Infinity",
    "-Infinity",
    "1e2",
    "1E2",
    "1e2.00",
    "+10.00",
    "10,00",
    ".50",
    "10.",
    "25",
    "25.0",
    "25.000",
    "1.234",
    "10.999",
    " 10.00",
    "10.00 ",
    "10.00\n",
    "10.00\r\n",
    "10.00\t",
    "1 000.00",
    "1_000.00",
    "0x10.00",
    "１０.００",
  ])("rejects invalid decimal text %j", (amount) => {
    expect(() => money(amount)).toThrow(InvalidMoneyError);
  });

  test.each([
    "-1.00",
    "-0.01",
    "-100.00",
    "-0.00",
  ])("rejects the external signed amount %s", (amount) => {
    expect(() => money(amount)).toThrow(InvalidMoneyError);
  });

  test.each([
    "",
    "brl",
    "BrL",
    "REAL",
    "BR",
    "123",
    "B1L",
    " BRL",
    "BRL ",
    "BRL\n",
  ])("rejects invalid currency %j in both factories", (currency) => {
    expect(() => money("1.00", currency)).toThrow(InvalidMoneyError);
    expect(() => Money.zero(currency)).toThrow(InvalidMoneyError);
  });
});

describe("Money arithmetic", () => {
  test.each([
    ["0.10", "0.20", "0.30"],
    ["10.00", "5.00", "15.00"],
    ["25.90", "0.10", "26.00"],
    ["0.00", "0.00", "0.00"],
    ["999999999999.99", "0.01", "1000000000000.00"],
    [
      "999999999999999999999999999999.99",
      "0.01",
      "1000000000000000000000000000000.00",
    ],
  ])("adds %s and %s exactly", (left, right, expected) => {
    const result = money(left).add(money(right));
    expect(result.toJSON()).toEqual({ amount: expected, currency: "BRL" });
  });

  test.each([
    ["20.00", "10.00", "10.00"],
    ["10.00", "10.00", "0.00"],
    ["10.00", "20.00", "-10.00"],
    ["0.30", "0.20", "0.10"],
    [
      "1000000000000000000000000000000.00",
      "0.01",
      "999999999999999999999999999999.99",
    ],
  ])("subtracts %s minus %s exactly", (left, right, expected) => {
    expect(money(left).subtract(money(right)).toString()).toBe(
      `${expected} BRL`,
    );
  });

  test("adds and subtracts internally produced negative values", () => {
    const negative = money("20.00").negate();
    const positive = money("10.00");
    expect(negative.add(positive).toString()).toBe("-10.00 BRL");
    expect(positive.add(negative).toString()).toBe("-10.00 BRL");
    expect(negative.add(negative).toString()).toBe("-40.00 BRL");
    expect(negative.subtract(positive).toString()).toBe("-30.00 BRL");
    expect(positive.subtract(negative).toString()).toBe("30.00 BRL");
    expect(negative.subtract(negative).toString()).toBe("0.00 BRL");
  });

  test("keeps precision across chained operations", () => {
    const original = money("999999999999999999999999999999.99");
    const result = original.add(money("0.01")).subtract(money("0.02")).negate();
    expect(result.toString()).toBe("-999999999999999999999999999999.98 BRL");
  });

  test("is independent of changes to the global Decimal precision", () => {
    const precision = Decimal.precision;
    try {
      Decimal.set({ precision: 3 });
      const original = money("123456789012345678901234567890.12");
      expect(original.add(money("0.01")).toString()).toBe(
        "123456789012345678901234567890.13 BRL",
      );
      expect(original.subtract(money("0.01")).toString()).toBe(
        "123456789012345678901234567890.11 BRL",
      );
      expect(Decimal.precision).toBe(3);
    } finally {
      Decimal.set({ precision });
    }
  });

  test("negates a positive value", () => {
    expect(money("10.00").negate().toString()).toBe("-10.00 BRL");
  });

  test("negates an internal negative value back to positive", () => {
    expect(money("10.00").negate().negate().toString()).toBe("10.00 BRL");
  });

  test("serializes negated zero canonically", () => {
    const zero = Money.zero("BRL").negate();
    expect(zero.toString()).toBe("0.00 BRL");
    expect(zero.toJSON()).toEqual({ amount: "0.00", currency: "BRL" });
    expect(zero.negate().toString()).toBe("0.00 BRL");
    expect(zero.isZero()).toBe(true);
    expect(zero.isPositive()).toBe(false);
    expect(zero.isNegative()).toBe(false);
  });
});

describe("Money comparisons", () => {
  test("classifies zero as neither positive nor negative", () => {
    const zero = Money.zero("BRL");
    expect(zero.isZero()).toBe(true);
    expect(zero.isPositive()).toBe(false);
    expect(zero.isNegative()).toBe(false);
  });

  test("classifies a positive value", () => {
    const positive = money("0.01");
    expect(positive.isZero()).toBe(false);
    expect(positive.isPositive()).toBe(true);
    expect(positive.isNegative()).toBe(false);
  });

  test("classifies an internal negative value", () => {
    const negative = money("0.01").negate();
    expect(negative.isZero()).toBe(false);
    expect(negative.isPositive()).toBe(false);
    expect(negative.isNegative()).toBe(true);
  });

  test("compares numerically rather than lexicographically", () => {
    expect(money("2.00").isLessThan(money("10.00"))).toBe(true);
    expect(money("10.00").isLessThan(money("2.00"))).toBe(false);
    expect(money("2.00").isLessThan(money("2.00"))).toBe(false);
  });

  test("orders negative values, zero and positive values", () => {
    const zero = Money.zero("BRL");
    expect(money("10.00").negate().isLessThan(money("2.00").negate())).toBe(
      true,
    );
    expect(money("0.01").negate().isLessThan(zero)).toBe(true);
    expect(zero.isLessThan(money("0.01"))).toBe(true);
    expect(zero.isLessThan(zero.negate())).toBe(false);
  });

  test("compares equal values independently of object identity and leading zeros", () => {
    expect(money("10.00").equals(money("010.00"))).toBe(true);
    expect(money("10.00").equals(money("10.01"))).toBe(false);
    expect(money("10.00").negate().equals(money("10.00").negate())).toBe(true);
    expect(money("10.00").equals(money("10.00").negate())).toBe(false);
    expect(Money.zero("BRL").equals(Money.zero("BRL").negate())).toBe(true);
  });

  test("treats equal amounts in different currencies as unequal", () => {
    expect(money("10.00", "BRL").equals(money("10.00", "USD"))).toBe(false);
    expect(Money.zero("BRL").equals(Money.zero("USD"))).toBe(false);
  });

  test.each([
    "add",
    "subtract",
    "isLessThan",
  ] as const)("rejects currency mismatch in %s with a domain error", (operation) => {
    const left = money("10.00", "BRL");
    const right = money("5.00", "USD");
    expect(() => left[operation](right)).toThrow(CurrencyMismatchError);
    expect(() => left[operation](right)).toThrow(
      "Currency mismatch: expected BRL, received USD",
    );
    expect(() => right[operation](left)).toThrow(CurrencyMismatchError);
  });
});

describe("Money immutability and serialization", () => {
  test("returns new instances without changing either operand", () => {
    const original = money("10.00");
    const other = money("5.00");
    const added = original.add(other);
    const subtracted = original.subtract(other);
    const negated = original.negate();
    expect(added).not.toBe(original);
    expect(added).not.toBe(other);
    expect(subtracted).not.toBe(original);
    expect(subtracted).not.toBe(other);
    expect(negated).not.toBe(original);
    expect(added.toString()).toBe("15.00 BRL");
    expect(subtracted.toString()).toBe("5.00 BRL");
    expect(negated.toString()).toBe("-10.00 BRL");
    expect(original.toString()).toBe("10.00 BRL");
    expect(other.toString()).toBe("5.00 BRL");
  });

  test("returns new instances even for operations preserving the value", () => {
    const original = money("10.00");
    const zero = Money.zero("BRL");
    expect(original.add(zero)).not.toBe(original);
    expect(original.subtract(zero)).not.toBe(original);
    expect(zero.negate()).not.toBe(zero);
  });

  test("freezes every instance and prevents runtime property replacement", () => {
    const original = money("10.00");
    for (const value of [
      original,
      Money.zero("BRL"),
      original.add(original),
      original.subtract(original),
      original.negate(),
    ]) {
      expect(Object.isFrozen(value)).toBe(true);
      expect(Reflect.set(value, "currency", "USD")).toBe(false);
      expect(Reflect.set(value, "value", new Decimal("999.00"))).toBe(false);
      expect(() =>
        Object.defineProperty(value, "currency", { value: "USD" }),
      ).toThrow(TypeError);
      expect(value.currency).toBe("BRL");
    }
    expect(original.toString()).toBe("10.00 BRL");
  });

  test("does not retain mutable input properties", () => {
    const props = { amount: "25.50", currency: "EUR" };
    const value = Money.from(props);
    props.amount = "99.00";
    props.currency = "USD";
    expect(value.toString()).toBe("25.50 EUR");
  });

  test("returns independent JSON properties without exposing Decimal", () => {
    const value = money("25.50", "EUR");
    const props = value.toJSON();
    expect(props).toEqual({ amount: "25.50", currency: "EUR" });
    expect(Object.keys(props)).toEqual(["amount", "currency"]);
    expect(Object.getOwnPropertyNames(value)).toEqual(["currency"]);
    expect(value.toJSON()).not.toBe(props);
    props.amount = "99.00";
    props.currency = "USD";
    expect(value.toJSON()).toEqual({ amount: "25.50", currency: "EUR" });
  });

  test("serializes through JSON.stringify using string properties", () => {
    expect(JSON.stringify(money("25.50", "USD"))).toBe(
      '{"amount":"25.50","currency":"USD"}',
    );
    expect(JSON.stringify(money("10.00").negate())).toBe(
      '{"amount":"-10.00","currency":"BRL"}',
    );
    expect(JSON.stringify(Money.zero("BRL").negate())).toBe(
      '{"amount":"0.00","currency":"BRL"}',
    );
  });

  test("formats human-readable values deterministically", () => {
    expect(money("25.00").toString()).toBe("25.00 BRL");
    expect(money("10.00").negate().toString()).toBe("-10.00 BRL");
    expect(Money.zero("BRL").toString()).toBe("0.00 BRL");
  });
});
