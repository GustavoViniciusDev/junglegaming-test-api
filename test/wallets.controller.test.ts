import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { DriverException } from "@mikro-orm/core";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import {
  CreateWallet,
  WalletAlreadyExistsError,
  WalletCreationUnavailableError,
} from "../src/wallet/application/create-wallet";
import { isTransientPostgresFailure } from "../src/wallet/infrastructure/mikro-orm-wallet-creation-store";
import { WalletsController } from "../src/wallet/wallets.controller";
import {
  ReadWallet,
  ReadWalletLedger,
} from "../src/wallet/application/read-wallet";

describe("WalletsController error classification", () => {
  let app: INestApplication;
  let baseUrl: string;
  let executeWallet: () => Promise<never>;

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [WalletsController],
      providers: [
        {
          provide: CreateWallet,
          useValue: { execute: () => executeWallet() },
        },
        { provide: ReadWallet, useValue: { execute: async () => null } },
        { provide: ReadWalletLedger, useValue: { execute: async () => null } },
      ],
    }).compile();
    app = module.createNestApplication();
    await app.listen(0, "127.0.0.1");
    baseUrl = await app.getUrl();
  });

  afterAll(async () => {
    await app.close();
  });

  async function post(body: unknown): Promise<Response> {
    return fetch(`${baseUrl}/wallets`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  function validPayload() {
    return {
      playerId: "player-http-classification",
      currency: "BRL",
      initialBalance: "1.00",
    };
  }

  test("returns 400 for invalid input", async () => {
    const response = await post({ ...validPayload(), initialBalance: 1 });
    expect(response.status).toBe(400);
  });

  test("returns 409 for a duplicate wallet", async () => {
    executeWallet = async () => {
      throw new WalletAlreadyExistsError();
    };
    expect((await post(validPayload())).status).toBe(409);
  });

  test("returns 500 for an unexpected application error", async () => {
    executeWallet = async () => {
      throw new Error("Unexpected application failure");
    };
    expect((await post(validPayload())).status).toBe(500);
  });

  test("returns 503 only for an explicitly classified availability error", async () => {
    executeWallet = async () => {
      throw new WalletCreationUnavailableError();
    };
    expect((await post(validPayload())).status).toBe(503);
  });

  test("classifies only known transient PostgreSQL driver codes", () => {
    const connectionError = new DriverException(
      Object.assign(new Error("Connection refused"), {
        code: "ECONNREFUSED",
      }),
    );
    const constraintError = new DriverException(
      Object.assign(new Error("Constraint violation"), { code: "23514" }),
    );

    expect(isTransientPostgresFailure(connectionError)).toBe(true);
    expect(isTransientPostgresFailure(constraintError)).toBe(false);
    expect(isTransientPostgresFailure(new Error("Unknown failure"))).toBe(
      false,
    );
  });
});
