import { z } from "zod";
import type { ProcessWagerTransactionInput } from "./process-wager-transaction";
import { wagerTransactionDataSchema } from "../contracts/wager-transaction-data.schema";
import { WagerTransactionKind } from "../domain/wager-transaction-kind";

export const WAGER_TRANSACTION_REQUESTED_TYPE =
  "wager.transaction.requested.v1";

export interface WagerTransactionRequestedEnvelope {
  messageId: string;
  type: typeof WAGER_TRANSACTION_REQUESTED_TYPE;
  occurredAt: string;
  data: ProcessWagerTransactionInput;
}

export class PermanentWagerMessageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermanentWagerMessageError";
  }
}

const envelopeSchema = z
  .object({
    messageId: z.string().refine((value) => value.trim().length > 0),
    type: z.string(),
    occurredAt: z.string().datetime({ offset: true }),
    data: z.unknown(),
  })
  .strict();

export function parseWagerTransactionRequested(
  body: string | undefined,
): WagerTransactionRequestedEnvelope {
  let parsedJson: unknown;
  try {
    if (body === undefined) throw new Error("Message body is missing");
    parsedJson = JSON.parse(body);
  } catch {
    throw new PermanentWagerMessageError("Message body is not valid JSON");
  }

  const envelope = envelopeSchema.safeParse(parsedJson);
  if (!envelope.success) {
    throw new PermanentWagerMessageError("Message envelope is invalid");
  }
  if (envelope.data.type !== WAGER_TRANSACTION_REQUESTED_TYPE) {
    throw new PermanentWagerMessageError("Message type is not supported");
  }

  if (
    typeof envelope.data.data !== "object" ||
    envelope.data.data === null ||
    Array.isArray(envelope.data.data)
  ) {
    throw new PermanentWagerMessageError("Message data is invalid");
  }
  const record = envelope.data.data as Record<string, unknown>;
  const idempotencyKey = record.idempotencyKey;
  if (
    typeof idempotencyKey !== "string" ||
    idempotencyKey.trim().length === 0
  ) {
    throw new PermanentWagerMessageError("Message idempotency key is invalid");
  }
  const businessFields = Object.fromEntries(
    Object.entries(record).filter(([key]) => key !== "idempotencyKey"),
  );
  const data = wagerTransactionDataSchema.safeParse(businessFields);
  if (!data.success) {
    throw new PermanentWagerMessageError("Message data is invalid");
  }
  const referenceExternalTransactionId =
    data.data.referenceExternalTransactionId;
  const validatedData = data.data;

  return {
    messageId: envelope.data.messageId,
    type: WAGER_TRANSACTION_REQUESTED_TYPE,
    occurredAt: envelope.data.occurredAt,
    data: {
      providerId: validatedData.providerId,
      externalTransactionId: validatedData.externalTransactionId,
      playerId: validatedData.playerId,
      walletId: validatedData.walletId,
      roundId: validatedData.roundId,
      gameId: validatedData.gameId,
      kind: WagerTransactionKind[validatedData.kind],
      money: validatedData.money,
      idempotencyKey,
      ...(typeof referenceExternalTransactionId !== "string"
        ? {}
        : { referenceExternalTransactionId }),
    },
  };
}
