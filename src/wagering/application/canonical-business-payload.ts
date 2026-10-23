import { createHash } from "node:crypto";
import { Money, type MoneyProps } from "../../shared/domain/money";
import { WagerTransactionKind } from "../domain/wager-transaction-kind";

export interface WagerTransactionBusinessPayload {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: Exclude<WagerTransactionKind, WagerTransactionKind.OPENING>;
  money: MoneyProps;
  referenceExternalTransactionId?: string | null | undefined;
}

export class InvalidWagerTransactionBusinessPayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidWagerTransactionBusinessPayloadError";
  }
}

function isIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function canonicalizeJson(value: unknown): string {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) {
      throw new InvalidWagerTransactionBusinessPayloadError(
        "Canonical payload contains an unsupported JSON value",
      );
    }
    return serialized;
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new InvalidWagerTransactionBusinessPayloadError(
        "Canonical payload numbers must be finite",
      );
    }
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${Array.from(value, canonicalizeJson).join(",")}]`;
  }

  if (typeof value === "object" && value !== null) {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new InvalidWagerTransactionBusinessPayloadError(
        "Canonical payload objects must be plain JSON objects",
      );
    }
    const properties = Object.entries(value).sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0,
    );
    return `{${properties
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalizeJson(item)}`)
      .join(",")}}`;
  }

  throw new InvalidWagerTransactionBusinessPayloadError(
    "Canonical payload must contain only JSON values",
  );
}

function toCanonicalBusinessFields(payload: WagerTransactionBusinessPayload) {
  for (const [field, value] of Object.entries({
    providerId: payload.providerId,
    externalTransactionId: payload.externalTransactionId,
    playerId: payload.playerId,
    walletId: payload.walletId,
    roundId: payload.roundId,
    gameId: payload.gameId,
  })) {
    if (!isIdentifier(value)) {
      throw new InvalidWagerTransactionBusinessPayloadError(
        `${field} must be a non-empty identifier`,
      );
    }
  }

  if (
    !Object.values(WagerTransactionKind).some(
      (kind) => kind !== WagerTransactionKind.OPENING && kind === payload.kind,
    )
  ) {
    throw new InvalidWagerTransactionBusinessPayloadError(
      "Provider transaction kind must be supported",
    );
  }

  const money = Money.from(payload.money);
  const referenceExternalTransactionId =
    payload.referenceExternalTransactionId ?? null;
  if (
    referenceExternalTransactionId !== null &&
    !isIdentifier(referenceExternalTransactionId)
  ) {
    throw new InvalidWagerTransactionBusinessPayloadError(
      "External reference must be null or a non-empty identifier",
    );
  }

  return {
    providerId: payload.providerId,
    externalTransactionId: payload.externalTransactionId,
    playerId: payload.playerId,
    walletId: payload.walletId,
    roundId: payload.roundId,
    gameId: payload.gameId,
    kind: payload.kind,
    money: money.toJSON(),
    referenceExternalTransactionId,
  };
}

export function canonicalizeWagerTransactionBusinessPayload(
  payload: WagerTransactionBusinessPayload,
): string {
  return canonicalizeJson(toCanonicalBusinessFields(payload));
}

export function hashWagerTransactionBusinessPayload(
  payload: WagerTransactionBusinessPayload,
): string {
  return createHash("sha256")
    .update(canonicalizeWagerTransactionBusinessPayload(payload), "utf8")
    .digest("hex");
}
