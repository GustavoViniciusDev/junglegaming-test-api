import { DriverException } from "@mikro-orm/core";

const transientPostgresErrorCodes = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "57P01",
  "57P02",
  "57P03",
]);

const postgresConcurrencyErrorCodes = new Set(["40P01", "55P03", "40001"]);

export function isTransientPostgresFailure(error: unknown): boolean {
  return (
    error instanceof DriverException &&
    typeof error.code === "string" &&
    transientPostgresErrorCodes.has(error.code)
  );
}

export function isPostgresConcurrencyConflict(error: unknown): boolean {
  return (
    error instanceof DriverException &&
    typeof error.code === "string" &&
    postgresConcurrencyErrorCodes.has(error.code)
  );
}
