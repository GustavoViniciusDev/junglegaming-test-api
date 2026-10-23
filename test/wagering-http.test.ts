import { describe, expect, test } from "bun:test";
import "reflect-metadata";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { InfrastructureUnavailableError } from "../src/shared/application/infrastructure-unavailable-error";
import {
  IdempotencyConflictError,
  ProcessWagerTransaction,
  WagerCurrencyMismatchError,
  WagerWalletNotFoundError,
} from "../src/wagering/application/process-wager-transaction";
import { WageringTransactionsController } from "../src/wagering/wagering-transactions.controller";
import { wagerTransactionDataSchema } from "../src/wagering/contracts/wager-transaction-data.schema";

const validRequest = {
  providerId: "provider-a",
  externalTransactionId: "external-a",
  playerId: "player-a",
  walletId: "wallet-a",
  roundId: "round-a",
  gameId: "game-a",
  kind: "BET",
  money: { amount: "10.00", currency: "BRL" },
};

describe("wager transaction HTTP request validation", () => {
  test("preserves decimal strings and rejects transport-only fields", () => {
    const parsed = wagerTransactionDataSchema.safeParse(validRequest);
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(typeof parsed.data.money.amount).toBe("string");
    expect(
      wagerTransactionDataSchema.safeParse({
        ...validRequest,
        idempotencyKey: "body-key",
      }).success,
    ).toBe(false);
  });

  test("rejects invalid money, public OPENING, and invalid reference shapes", () => {
    for (const amount of [10, "10", "10.0", "10.000", "1e2", "-1.00"]) {
      expect(
        wagerTransactionDataSchema.safeParse({
          ...validRequest,
          money: { amount, currency: "BRL" },
        }).success,
      ).toBe(false);
    }
    expect(
      wagerTransactionDataSchema.safeParse({
        ...validRequest,
        kind: "OPENING",
      }).success,
    ).toBe(false);
    expect(
      wagerTransactionDataSchema.safeParse({
        ...validRequest,
        kind: "REFUND",
      }).success,
    ).toBe(false);
    expect(
      wagerTransactionDataSchema.safeParse({
        ...validRequest,
        referenceExternalTransactionId: "reference-a",
      }).success,
    ).toBe(false);
    expect(
      wagerTransactionDataSchema.safeParse({
        ...validRequest,
        kind: "LOSS",
        referenceExternalTransactionId: "reference-a",
      }).success,
    ).toBe(false);
    expect(wagerTransactionDataSchema.safeParse(undefined).success).toBe(false);
    expect(
      wagerTransactionDataSchema.safeParse({
        ...validRequest,
        money: undefined,
      }).success,
    ).toBe(false);
    for (const field of [
      "providerId",
      "externalTransactionId",
      "playerId",
      "walletId",
      "roundId",
      "gameId",
    ]) {
      const incomplete = Object.fromEntries(
        Object.entries(validRequest).filter(([key]) => key !== field),
      );
      expect(wagerTransactionDataSchema.safeParse(incomplete).success).toBe(
        false,
      );
    }
    expect(
      wagerTransactionDataSchema.safeParse({
        ...validRequest,
        kind: "REFUND",
        referenceExternalTransactionId: " ",
      }).success,
    ).toBe(false);
    expect(
      wagerTransactionDataSchema.safeParse({
        ...validRequest,
        money: { amount: "1.00", currency: "usd" },
      }).success,
    ).toBe(false);
  });

  test("maps known processing errors and hides unexpected failures", async () => {
    let failure: unknown = new Error("database password must not leak");
    const module = await Test.createTestingModule({
      controllers: [WageringTransactionsController],
      providers: [
        {
          provide: ProcessWagerTransaction,
          useValue: { execute: async () => Promise.reject(failure) },
        },
      ],
    }).compile();
    const app: INestApplication = module.createNestApplication();
    await app.listen(0, "127.0.0.1");
    const baseUrl = await app.getUrl();
    try {
      const send = () =>
        fetch(`${baseUrl}/wagering/transactions`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "idempotency-key": "test-key",
          },
          body: JSON.stringify(validRequest),
        });
      const unexpected = await send();
      expect(unexpected.status).toBe(500);
      const unexpectedBody = (await unexpected.json()) as { message: string };
      expect(unexpectedBody.message).not.toContain("password");
      failure = new InfrastructureUnavailableError();
      expect((await send()).status).toBe(503);
      failure = new IdempotencyConflictError();
      expect((await send()).status).toBe(409);
      failure = new WagerWalletNotFoundError("wallet-a");
      expect((await send()).status).toBe(404);
      failure = new WagerCurrencyMismatchError();
      expect((await send()).status).toBe(422);
    } finally {
      await app.close();
    }
  });
});
