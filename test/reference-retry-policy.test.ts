import { describe, expect, test } from "bun:test";
import { nextReferenceAttemptAt } from "../src/wagering/application/reference-retry-policy";

describe("reference retry policy", () => {
  test("uses deterministic exponential delays from the configured base", () => {
    const now = new Date("2026-01-01T00:00:00.000Z");
    expect(nextReferenceAttemptAt(now, 1, 1000).toISOString()).toBe(
      "2026-01-01T00:00:02.000Z",
    );
    expect(nextReferenceAttemptAt(now, 2, 1000).toISOString()).toBe(
      "2026-01-01T00:00:04.000Z",
    );
  });

  test("rejects invalid retry scheduling values", () => {
    const now = new Date("2026-01-01T00:00:00.000Z");
    expect(() => nextReferenceAttemptAt(now, -1, 1000)).toThrow(RangeError);
    expect(() => nextReferenceAttemptAt(now, 1, 0)).toThrow(RangeError);
    expect(() => nextReferenceAttemptAt(new Date(Number.NaN), 1, 1000)).toThrow(
      RangeError,
    );
  });
});
