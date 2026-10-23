import { InvalidReadRequestError } from "./read-errors";

export interface LedgerCursor {
  walletId: string;
  createdAt: Date;
  id: string;
}

const cursorKeys = ["createdAt", "id", "v", "walletId"];

export function encodeLedgerCursor(cursor: LedgerCursor): string {
  return Buffer.from(
    JSON.stringify({
      v: 1,
      walletId: cursor.walletId,
      createdAt: cursor.createdAt.toISOString(),
      id: cursor.id,
    }),
    "utf8",
  ).toString("base64url");
}

export function decodeLedgerCursor(
  value: string,
  walletId: string,
): LedgerCursor {
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error();
    const decoded = Buffer.from(value, "base64url").toString("utf8");
    if (Buffer.from(decoded, "utf8").toString("base64url") !== value) {
      throw new Error();
    }
    const parsed: unknown = JSON.parse(decoded);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed) ||
      Object.getPrototypeOf(parsed) !== Object.prototype
    ) {
      throw new Error();
    }
    const record = parsed as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    if (
      keys.length !== cursorKeys.length ||
      keys.some((key, index) => key !== cursorKeys[index]) ||
      record.v !== 1 ||
      record.walletId !== walletId ||
      typeof record.createdAt !== "string" ||
      typeof record.id !== "string" ||
      record.id.trim().length === 0
    ) {
      throw new Error();
    }
    const createdAt = new Date(record.createdAt);
    if (
      !Number.isFinite(createdAt.getTime()) ||
      createdAt.toISOString() !== record.createdAt
    ) {
      throw new Error();
    }
    return { walletId, createdAt, id: record.id };
  } catch {
    throw new InvalidReadRequestError("Ledger cursor is invalid");
  }
}

export function parseLedgerLimit(value: string | undefined): number {
  if (value === undefined) return 50;
  if (!/^\d+$/.test(value)) {
    throw new InvalidReadRequestError("Ledger limit must be an integer");
  }
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new InvalidReadRequestError("Ledger limit must be between 1 and 100");
  }
  return limit;
}
