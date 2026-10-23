import { z } from "zod";

const identifier = z.string().refine((value) => value.trim().length > 0);
const moneySchema = z
  .object({
    amount: z.string().regex(/^[0-9]+\.[0-9]{2}$/),
    currency: z.string().regex(/^[A-Z]{3}$/),
  })
  .strict();

export const wagerTransactionDataSchema = z
  .object({
    providerId: identifier,
    externalTransactionId: identifier,
    playerId: identifier,
    walletId: identifier,
    roundId: identifier,
    gameId: identifier,
    kind: z.enum(["BET", "WIN", "LOSS", "REFUND", "ROLLBACK"]),
    money: moneySchema,
    referenceExternalTransactionId: identifier.optional(),
  })
  .strict()
  .superRefine((request, context) => {
    const requiresReference =
      request.kind === "REFUND" || request.kind === "ROLLBACK";
    const forbidsReference = request.kind === "BET" || request.kind === "LOSS";
    if (
      requiresReference &&
      request.referenceExternalTransactionId === undefined
    ) {
      context.addIssue({
        code: "custom",
        path: ["referenceExternalTransactionId"],
        message: `${request.kind} requires an external reference`,
      });
    }
    if (
      forbidsReference &&
      request.referenceExternalTransactionId !== undefined
    ) {
      context.addIssue({
        code: "custom",
        path: ["referenceExternalTransactionId"],
        message: `${request.kind} must not contain an external reference`,
      });
    }
  });

export type WagerTransactionData = z.infer<typeof wagerTransactionDataSchema>;
