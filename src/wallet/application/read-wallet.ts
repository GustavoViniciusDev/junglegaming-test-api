import type { LedgerCursor } from "../../shared/application/ledger-cursor";
import {
  decodeLedgerCursor,
  encodeLedgerCursor,
  parseLedgerLimit,
} from "../../shared/application/ledger-cursor";
import {
  InvalidReadRequestError,
  ReadResourceNotFoundError,
} from "../../shared/application/read-errors";
import type { Wallet } from "../domain/wallet";
import type { WalletLedgerEntry } from "../domain/wallet-ledger-entry";

export interface WalletReadStore {
  findWallet(walletId: string): Promise<Wallet | null>;
  findLedgerEntries(input: {
    walletId: string;
    cursor: LedgerCursor | null;
    take: number;
  }): Promise<WalletLedgerEntry[]>;
}

export class ReadWallet {
  constructor(private readonly store: WalletReadStore) {}

  async execute(walletId: string): Promise<Wallet> {
    if (walletId.trim().length === 0) {
      throw new InvalidReadRequestError("Wallet id must not be empty");
    }
    const wallet = await this.store.findWallet(walletId);
    if (wallet === null) throw new ReadResourceNotFoundError("Wallet");
    return wallet;
  }
}

export interface WalletLedgerPage {
  items: WalletLedgerEntry[];
  nextCursor: string | null;
}

export class ReadWalletLedger {
  constructor(private readonly store: WalletReadStore) {}

  async execute(input: {
    walletId: string;
    cursor?: string;
    limit?: string;
  }): Promise<WalletLedgerPage> {
    if (input.walletId.trim().length === 0) {
      throw new InvalidReadRequestError("Wallet id must not be empty");
    }
    const limit = parseLedgerLimit(input.limit);
    const cursor =
      input.cursor === undefined
        ? null
        : decodeLedgerCursor(input.cursor, input.walletId);
    if ((await this.store.findWallet(input.walletId)) === null) {
      throw new ReadResourceNotFoundError("Wallet");
    }

    const results = await this.store.findLedgerEntries({
      walletId: input.walletId,
      cursor,
      take: limit + 1,
    });
    const hasMore = results.length > limit;
    const items = hasMore ? results.slice(0, limit) : results;
    const lastItem = items.at(-1);
    return {
      items,
      nextCursor:
        hasMore && lastItem !== undefined
          ? encodeLedgerCursor({
              walletId: input.walletId,
              createdAt: lastItem.createdAt,
              id: lastItem.id,
            })
          : null,
    };
  }
}
