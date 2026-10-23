import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { Money } from "../src/shared/domain/money";
import {
  CreateWallet,
  WalletAlreadyExistsError,
  type WalletCreationArtifacts,
  type WalletCreationStore,
} from "../src/wallet/application/create-wallet";
import { LedgerDirection } from "../src/wallet/domain/ledger-direction";
import { WagerTransactionStatus } from "../src/wagering/domain/wager-transaction-status";

class RecordingWalletCreationStore implements WalletCreationStore {
  artifacts: WalletCreationArtifacts | null = null;
  error: Error | null = null;

  async persistAtomically(artifacts: WalletCreationArtifacts): Promise<void> {
    if (this.error) throw this.error;
    this.artifacts = artifacts;
  }
}

describe("CreateWallet", () => {
  test("creates a zero-balance wallet without financial artifacts", async () => {
    const store = new RecordingWalletCreationStore();
    const wallet = await new CreateWallet(store).execute({
      playerId: "player-zero",
      currency: "BRL",
      initialBalance: "0.00",
    });

    expect(wallet.balance.toJSON()).toEqual({
      amount: "0.00",
      currency: "BRL",
    });
    expect(wallet.version).toBe(1);
    expect(store.artifacts).not.toBeNull();
    expect(store.artifacts?.opening).toBeNull();
    expect(store.artifacts?.ledgerEntry).toBeNull();
    expect(store.artifacts?.outboxMessages).toEqual([]);
  });

  test("creates opening ledger and two outbox events for positive balance", async () => {
    const store = new RecordingWalletCreationStore();
    const wallet = await new CreateWallet(store).execute({
      playerId: "player-funded",
      currency: "BRL",
      initialBalance: "0.30",
    });
    const artifacts = store.artifacts;

    expect(wallet.version).toBe(1);
    expect(wallet.id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(wallet.createdAt).toBeInstanceOf(Date);
    expect(artifacts?.opening?.status).toBe(WagerTransactionStatus.PROCESSED);
    expect(artifacts?.opening?.providerId).toBeNull();
    expect(artifacts?.opening?.externalTransactionId).toBeNull();
    expect(artifacts?.opening?.money.toJSON()).toEqual({
      amount: "0.30",
      currency: "BRL",
    });
    expect(artifacts?.opening?.resultingBalance?.toJSON()).toEqual({
      amount: "0.30",
      currency: "BRL",
    });
    expect(artifacts?.opening?.idempotencyKey).toBe(
      `wallet-opening:${wallet.id}`,
    );
    expect(artifacts?.opening?.payloadHash).toBe(
      createHash("sha256")
        .update(`wallet-opening:v1\n${wallet.id}\nBRL\n0.30`)
        .digest("hex"),
    );
    expect(artifacts?.ledgerEntry?.direction).toBe(LedgerDirection.CREDIT);
    expect(artifacts?.ledgerEntry?.balanceBefore.toJSON()).toEqual({
      amount: "0.00",
      currency: "BRL",
    });
    expect(artifacts?.ledgerEntry?.balanceAfter.equals(wallet.balance)).toBe(
      true,
    );
    expect(artifacts?.outboxMessages).toHaveLength(2);
    expect(
      artifacts?.outboxMessages.map((message) => message.eventType).sort(),
    ).toEqual(["wager.transaction.processed.v1", "wallet.balance.changed.v1"]);
  });

  test("rejects an invalid decimal string before persistence", async () => {
    const store = new RecordingWalletCreationStore();
    await expect(
      new CreateWallet(store).execute({
        playerId: "player-invalid",
        currency: "BRL",
        initialBalance: "1.234",
      }),
    ).rejects.toThrow();
    expect(store.artifacts).toBeNull();
  });

  test("preserves exact decimal values and maps duplicate wallet conflicts", async () => {
    const store = new RecordingWalletCreationStore();
    store.error = new WalletAlreadyExistsError();
    const initialBalance = Money.from({ amount: "0.10", currency: "BRL" });
    expect(
      initialBalance
        .add(Money.from({ amount: "0.20", currency: "BRL" }))
        .toJSON().amount,
    ).toBe("0.30");
    await expect(
      new CreateWallet(store).execute({
        playerId: "player-duplicate",
        currency: "BRL",
        initialBalance: "0.10",
      }),
    ).rejects.toBeInstanceOf(WalletAlreadyExistsError);
  });
});
