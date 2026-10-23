import {
  InvalidReadRequestError,
  ReadResourceNotFoundError,
} from "../../shared/application/read-errors";
import type { WagerTransaction } from "../domain/wager-transaction";

export interface WagerTransactionReadStore {
  findById(transactionId: string): Promise<WagerTransaction | null>;
  findByProviderIdentity(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | null>;
}

export class ReadWagerTransaction {
  constructor(private readonly store: WagerTransactionReadStore) {}

  async byId(transactionId: string): Promise<WagerTransaction> {
    if (transactionId.trim().length === 0) {
      throw new InvalidReadRequestError("Transaction id must not be empty");
    }
    const transaction = await this.store.findById(transactionId);
    if (transaction === null) {
      throw new ReadResourceNotFoundError("Wager transaction");
    }
    return transaction;
  }

  async byProviderIdentity(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction> {
    if (providerId.trim().length === 0) {
      throw new InvalidReadRequestError("Provider id must not be empty");
    }
    if (externalTransactionId.trim().length === 0) {
      throw new InvalidReadRequestError(
        "External transaction id must not be empty",
      );
    }
    const transaction = await this.store.findByProviderIdentity(
      providerId,
      externalTransactionId,
    );
    if (transaction === null) {
      throw new ReadResourceNotFoundError("Wager transaction");
    }
    return transaction;
  }
}
