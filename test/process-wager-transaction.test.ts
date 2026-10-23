import { describe, expect, test } from "bun:test";
import { Money } from "../src/shared/domain/money";
import { LedgerDirection } from "../src/wallet/domain/ledger-direction";
import { Wallet } from "../src/wallet/domain/wallet";
import { WagerTransactionKind } from "../src/wagering/domain/wager-transaction-kind";
import { WagerTransaction } from "../src/wagering/domain/wager-transaction";
import {
  InvalidWagerProcessingRequestError,
  ProcessWagerTransaction,
  UnsupportedWagerTransactionKindError,
  type WagerTransactionProcessingArtifacts,
  type WagerTransactionProcessingContext,
  type WagerTransactionProcessingStore,
} from "../src/wagering/application/process-wager-transaction";
import { WagerTransactionStatus } from "../src/wagering/domain/wager-transaction-status";
import { WagerTransactionRejectionCode } from "../src/wagering/domain/wager-transaction-failure-code";

class InMemoryProcessingStore implements WagerTransactionProcessingStore {
  readonly wallet: Wallet;
  artifacts: WagerTransactionProcessingArtifacts | null = null;
  readonly references = new Map<string, WagerTransaction>();
  readonly reversals = new Set<string>();

  constructor(balance: string) {
    this.wallet = Wallet.open({
      id: "wallet-1",
      playerId: "player-1",
      currency: "BRL",
      balance: Money.from({ amount: balance, currency: "BRL" }),
    });
  }

  async executeIdempotently(
    _identity: {
      idempotencyKey: string;
      payloadHash: string;
      walletId: string;
      providerId: string;
      externalTransactionId: string;
    },
    createArtifacts: (
      context: WagerTransactionProcessingContext,
    ) => Promise<WagerTransactionProcessingArtifacts>,
  ) {
    this.artifacts = await createArtifacts({
      wallet: this.wallet,
      findReferenceTransaction: async (providerId, externalTransactionId) =>
        this.references.get(`${providerId}:${externalTransactionId}`) ?? null,
      hasProcessedReversal: async (referenceTransactionId, kind) =>
        this.reversals.has(`${referenceTransactionId}:${kind}`),
    });
    return { transaction: this.artifacts.transaction, idempotentReplay: false };
  }
}

function input(
  kind: WagerTransactionKind,
  amount = "20.00",
  referenceExternalTransactionId?: string,
) {
  return {
    providerId: "provider-1",
    externalTransactionId: `external-${kind}`,
    idempotencyKey: `key-${kind}`,
    playerId: "player-1",
    walletId: "wallet-1",
    roundId: "round-1",
    gameId: "game-1",
    kind,
    money: { amount, currency: "BRL" },
    ...(referenceExternalTransactionId === undefined
      ? {}
      : { referenceExternalTransactionId }),
  };
}

describe("ProcessWagerTransaction", () => {
  test("processes BET by debiting once and producing a ledger and two outbox messages", async () => {
    const store = new InMemoryProcessingStore("100.00");
    const result = await new ProcessWagerTransaction(store).execute(
      input(WagerTransactionKind.BET),
    );

    expect(result.status).toBe(WagerTransactionStatus.PROCESSED);
    expect(result.resultingBalance).toEqual({
      amount: "80.00",
      currency: "BRL",
    });
    expect(result.idempotentReplay).toBe(false);
    expect(store.wallet.balance.toJSON().amount).toBe("80.00");
    expect(store.wallet.version).toBe(2);
    expect(store.artifacts?.ledgerEntry?.direction).toBe(LedgerDirection.DEBIT);
    expect(store.artifacts?.outboxMessages).toHaveLength(2);
  });

  test("persists insufficient BET as rejection without financial changes", async () => {
    const store = new InMemoryProcessingStore("10.00");
    const result = await new ProcessWagerTransaction(store).execute(
      input(WagerTransactionKind.BET, "20.00"),
    );

    expect(result.status).toBe(WagerTransactionStatus.REJECTED);
    expect(result.failureCode).toBe(
      WagerTransactionRejectionCode.INSUFFICIENT_FUNDS,
    );
    expect(store.wallet.balance.toJSON().amount).toBe("10.00");
    expect(store.wallet.version).toBe(1);
    expect(store.artifacts?.ledgerEntry).toBeNull();
    expect(store.artifacts?.outboxMessages).toHaveLength(1);
  });

  test("processes WIN as a credit and preserves an optional external reference", async () => {
    const store = new InMemoryProcessingStore("10.00");
    const reference = WagerTransaction.create({
      id: "bet-1",
      providerId: "provider-1",
      externalTransactionId: "bet-external-1",
      idempotencyKey: "bet-key",
      payloadHash: "bet-hash",
      walletId: "wallet-1",
      playerId: "player-1",
      roundId: "round-1",
      gameId: "game-1",
      kind: WagerTransactionKind.BET,
      money: Money.from({ amount: "10.00", currency: "BRL" }),
    });
    reference.markProcessed(Money.from({ amount: "10.00", currency: "BRL" }));
    store.references.set("provider-1:bet-external-1", reference);
    await new ProcessWagerTransaction(store).execute(
      input(WagerTransactionKind.WIN, "5.00", "bet-external-1"),
    );

    expect(store.wallet.balance.toJSON().amount).toBe("15.00");
    expect(store.artifacts?.ledgerEntry?.direction).toBe(
      LedgerDirection.CREDIT,
    );
    expect(store.artifacts?.transaction.referenceExternalTransactionId).toBe(
      "bet-external-1",
    );
    expect(store.artifacts?.outboxMessages).toHaveLength(2);
  });

  test("waits for a pending BET reference and rejects a terminal unprocessed BET", async () => {
    const pendingStore = new InMemoryProcessingStore("10.00");
    const pendingBet = WagerTransaction.create({
      id: "pending-bet",
      providerId: "provider-1",
      externalTransactionId: "pending-bet-external",
      idempotencyKey: "pending-bet-key",
      payloadHash: "pending-bet-hash",
      walletId: "wallet-1",
      playerId: "player-1",
      roundId: "round-1",
      gameId: "game-1",
      kind: WagerTransactionKind.BET,
      money: Money.from({ amount: "10.00", currency: "BRL" }),
    });
    pendingStore.references.set("provider-1:pending-bet-external", pendingBet);

    const pendingResult = await new ProcessWagerTransaction(
      pendingStore,
    ).execute(input(WagerTransactionKind.WIN, "25.00", "pending-bet-external"));
    expect(pendingResult.status).toBe(WagerTransactionStatus.PENDING_REFERENCE);
    expect(pendingStore.wallet.balance.toJSON().amount).toBe("10.00");
    expect(pendingStore.wallet.version).toBe(1);
    expect(pendingStore.artifacts?.ledgerEntry).toBeNull();
    expect(pendingStore.artifacts?.outboxMessages).toHaveLength(1);
    expect(pendingStore.artifacts?.outboxMessages[0]?.eventType).toBe(
      "wager.transaction.pending-reference.v1",
    );

    const rejectedStore = new InMemoryProcessingStore("10.00");
    const rejectedBet = WagerTransaction.create({
      id: "rejected-bet",
      providerId: "provider-1",
      externalTransactionId: "rejected-bet-external",
      idempotencyKey: "rejected-bet-key",
      payloadHash: "rejected-bet-hash",
      walletId: "wallet-1",
      playerId: "player-1",
      roundId: "round-1",
      gameId: "game-1",
      kind: WagerTransactionKind.BET,
      money: Money.from({ amount: "10.00", currency: "BRL" }),
    });
    rejectedBet.reject(WagerTransactionRejectionCode.INSUFFICIENT_FUNDS);
    rejectedStore.references.set(
      "provider-1:rejected-bet-external",
      rejectedBet,
    );

    const rejectedResult = await new ProcessWagerTransaction(
      rejectedStore,
    ).execute(
      input(WagerTransactionKind.WIN, "25.00", "rejected-bet-external"),
    );
    expect(rejectedResult.status).toBe(WagerTransactionStatus.REJECTED);
    expect(rejectedResult.failureCode).toBe(
      WagerTransactionRejectionCode.REFERENCE_NOT_PROCESSED,
    );
    expect(rejectedStore.wallet.balance.toJSON().amount).toBe("10.00");
    expect(rejectedStore.wallet.version).toBe(1);
    expect(rejectedStore.artifacts?.ledgerEntry).toBeNull();
    expect(rejectedStore.artifacts?.outboxMessages).toHaveLength(1);
    expect(rejectedStore.artifacts?.outboxMessages[0]?.eventType).toBe(
      "wager.transaction.rejected.v1",
    );
  });

  test("processes LOSS without changing the wallet or creating a ledger", async () => {
    const store = new InMemoryProcessingStore("10.00");
    const result = await new ProcessWagerTransaction(store).execute(
      input(WagerTransactionKind.LOSS),
    );

    expect(result.resultingBalance).toEqual({
      amount: "10.00",
      currency: "BRL",
    });
    expect(store.wallet.balance.toJSON().amount).toBe("10.00");
    expect(store.wallet.version).toBe(1);
    expect(store.artifacts?.ledgerEntry).toBeNull();
    expect(store.artifacts?.outboxMessages).toHaveLength(1);
  });

  test("rejects OPENING while accepting supported reversal kinds structurally", async () => {
    const useCase = new ProcessWagerTransaction(
      new InMemoryProcessingStore("1.00"),
    );
    await expect(
      useCase.execute(input(WagerTransactionKind.OPENING)),
    ).rejects.toBeInstanceOf(UnsupportedWagerTransactionKindError);
    const refund = await useCase.execute(
      input(WagerTransactionKind.REFUND, "1.00", "missing-bet"),
    );
    const rollback = await useCase.execute(
      input(WagerTransactionKind.ROLLBACK, "1.00", "missing-bet-2"),
    );
    expect(refund.status).toBe(WagerTransactionStatus.PENDING_REFERENCE);
    expect(rollback.status).toBe(WagerTransactionStatus.PENDING_REFERENCE);
  });

  test("rejects non-positive BET/WIN and references on BET/LOSS", async () => {
    const useCase = new ProcessWagerTransaction(
      new InMemoryProcessingStore("1.00"),
    );
    await expect(
      useCase.execute(input(WagerTransactionKind.BET, "0.00")),
    ).rejects.toBeInstanceOf(InvalidWagerProcessingRequestError);
    await expect(
      useCase.execute(input(WagerTransactionKind.WIN, "0.00")),
    ).rejects.toBeInstanceOf(InvalidWagerProcessingRequestError);
    await expect(
      useCase.execute(input(WagerTransactionKind.BET, "1.00", "reference")),
    ).rejects.toBeInstanceOf(InvalidWagerProcessingRequestError);
    await expect(
      useCase.execute(input(WagerTransactionKind.LOSS, "1.00", "reference")),
    ).rejects.toBeInstanceOf(InvalidWagerProcessingRequestError);
  });

  test("rejects resolved references with provider or currency mismatches", async () => {
    const store = new InMemoryProcessingStore("10.00");
    const foreignProviderReference = WagerTransaction.create({
      id: "foreign-provider-bet",
      providerId: "other-provider",
      externalTransactionId: "foreign-provider-external",
      idempotencyKey: "foreign-provider-key",
      payloadHash: "foreign-provider-hash",
      walletId: store.wallet.id,
      playerId: store.wallet.playerId,
      roundId: "round-1",
      gameId: "game-1",
      kind: WagerTransactionKind.BET,
      money: Money.from({ amount: "10.00", currency: "BRL" }),
    });
    foreignProviderReference.markProcessed(
      Money.from({ amount: "10.00", currency: "BRL" }),
    );
    store.references.set(
      "provider-1:foreign-provider-external",
      foreignProviderReference,
    );

    const providerMismatch = await new ProcessWagerTransaction(store).execute(
      input(WagerTransactionKind.REFUND, "10.00", "foreign-provider-external"),
    );
    expect(providerMismatch.failureCode).toBe(
      WagerTransactionRejectionCode.REFERENCE_PROVIDER_MISMATCH,
    );

    const foreignCurrencyReference = WagerTransaction.create({
      id: "foreign-currency-bet",
      providerId: "provider-1",
      externalTransactionId: "foreign-currency-external",
      idempotencyKey: "foreign-currency-key",
      payloadHash: "foreign-currency-hash",
      walletId: store.wallet.id,
      playerId: store.wallet.playerId,
      roundId: "round-1",
      gameId: "game-1",
      kind: WagerTransactionKind.BET,
      money: Money.from({ amount: "10.00", currency: "USD" }),
    });
    foreignCurrencyReference.markProcessed(
      Money.from({ amount: "10.00", currency: "USD" }),
    );
    store.references.set(
      "provider-1:foreign-currency-external",
      foreignCurrencyReference,
    );
    const currencyMismatch = await new ProcessWagerTransaction(store).execute(
      input(WagerTransactionKind.REFUND, "10.00", "foreign-currency-external"),
    );
    expect(currencyMismatch.failureCode).toBe(
      WagerTransactionRejectionCode.REFERENCE_CURRENCY_MISMATCH,
    );
  });
});
