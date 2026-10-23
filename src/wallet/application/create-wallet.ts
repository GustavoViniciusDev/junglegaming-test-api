import { createHash, randomUUID } from "node:crypto";
import { InvalidMoneyError, Money } from "../../shared/domain/money";
import { OutboxMessage } from "../../outbox/domain/outbox-message";
import { WalletBalanceChanged } from "../domain/integration-events/wallet-balance-changed";
import { LedgerDirection } from "../domain/ledger-direction";
import { Wallet } from "../domain/wallet";
import { WalletLedgerEntry } from "../domain/wallet-ledger-entry";
import { WagerTransactionProcessed } from "../../wagering/domain/integration-events/wager-transaction-processed";
import { WagerTransaction } from "../../wagering/domain/wager-transaction";
import { InfrastructureUnavailableError } from "../../shared/application/infrastructure-unavailable-error";

export class WalletAlreadyExistsError extends Error {
  constructor() {
    super("A wallet already exists for this player and currency");
    this.name = "WalletAlreadyExistsError";
  }
}

export class WalletCreationUnavailableError extends InfrastructureUnavailableError {
  constructor() {
    super("Wallet creation is temporarily unavailable");
    this.name = "WalletCreationUnavailableError";
  }
}

export interface CreateWalletInput {
  playerId: string;
  currency: string;
  initialBalance: string;
}

export interface WalletCreationArtifacts {
  wallet: Wallet;
  opening: WagerTransaction | null;
  ledgerEntry: WalletLedgerEntry | null;
  outboxMessages: readonly OutboxMessage[];
}

export interface WalletCreationStore {
  persistAtomically(artifacts: WalletCreationArtifacts): Promise<void>;
}

export class CreateWallet {
  constructor(private readonly store: WalletCreationStore) {}

  async execute(input: CreateWalletInput): Promise<Wallet> {
    const initialBalance = Money.from({
      amount: input.initialBalance,
      currency: input.currency,
    });
    const now = new Date();
    const walletId = randomUUID();
    const wallet = Wallet.open(
      {
        id: walletId,
        playerId: input.playerId,
        currency: input.currency,
        balance: initialBalance,
      },
      now,
    );

    if (initialBalance.isZero()) {
      await this.store.persistAtomically({
        wallet,
        opening: null,
        ledgerEntry: null,
        outboxMessages: [],
      });
      return wallet;
    }

    const openingId = randomUUID();
    const opening = WagerTransaction.createOpening(
      {
        id: openingId,
        idempotencyKey: `wallet-opening:${walletId}`,
        payloadHash: createHash("sha256")
          .update(
            `wallet-opening:v1\n${walletId}\n${input.currency}\n${initialBalance.toJSON().amount}`,
          )
          .digest("hex"),
        walletId,
        playerId: input.playerId,
        money: initialBalance,
      },
      now,
    );
    opening.markProcessed(initialBalance, now);

    const ledgerEntry = WalletLedgerEntry.create(
      {
        id: randomUUID(),
        walletId,
        transactionId: openingId,
        direction: LedgerDirection.CREDIT,
        money: initialBalance,
        balanceBefore: Money.zero(input.currency),
        balanceAfter: initialBalance,
      },
      now,
    );

    const processedEvent = WagerTransactionProcessed.fromTransaction(
      randomUUID(),
      opening,
    );
    const balanceEvent = WalletBalanceChanged.create({
      id: randomUUID(),
      walletId,
      playerId: input.playerId,
      direction: LedgerDirection.CREDIT,
      money: initialBalance,
      balanceBefore: ledgerEntry.balanceBefore,
      balanceAfter: ledgerEntry.balanceAfter,
      transactionId: openingId,
      occurredAt: now,
    });

    await this.store.persistAtomically({
      wallet,
      opening,
      ledgerEntry,
      outboxMessages: [
        OutboxMessage.fromEvent(processedEvent),
        OutboxMessage.fromEvent(balanceEvent),
      ],
    });
    return wallet;
  }
}

export function isCreateWalletInput(
  value: unknown,
): value is CreateWalletInput {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    Object.keys(record).length === 3 &&
    typeof record.playerId === "string" &&
    record.playerId.trim().length > 0 &&
    typeof record.currency === "string" &&
    /^[A-Z]{3}$/.test(record.currency) &&
    typeof record.initialBalance === "string"
  );
}

export function isInvalidWalletInputError(error: unknown): boolean {
  return (
    error instanceof InvalidMoneyError ||
    (error instanceof Error &&
      ["InvalidWalletStateError", "CurrencyMismatchError"].includes(error.name))
  );
}
