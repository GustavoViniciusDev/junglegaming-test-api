import { UniqueConstraintViolationException } from "@mikro-orm/core";
import { MikroORM } from "@mikro-orm/postgresql";
import { Inject, Injectable } from "@nestjs/common";
import {
  outboxMessageToRecord,
  wagerTransactionToRecord,
  walletLedgerEntryToRecord,
  walletToRecord,
} from "../../infrastructure/database/domain-mappers";
import {
  WalletAlreadyExistsError,
  WalletCreationUnavailableError,
  type WalletCreationArtifacts,
  type WalletCreationStore,
} from "../application/create-wallet";
import { isTransientPostgresFailure } from "../../infrastructure/database/transient-postgres-failure";

export { isTransientPostgresFailure } from "../../infrastructure/database/transient-postgres-failure";

function violatesPlayerCurrencyConstraint(error: Error): boolean {
  return (
    "constraint" in error &&
    error.constraint === "wallets_player_currency_unique"
  );
}

@Injectable()
export class MikroOrmWalletCreationStore implements WalletCreationStore {
  constructor(@Inject(MikroORM) private readonly orm: MikroORM) {}

  async persistAtomically(artifacts: WalletCreationArtifacts): Promise<void> {
    const em = this.orm.em.fork({ clear: true });
    try {
      await em.transactional(async (transactionalEm) => {
        await transactionalEm.persist(walletToRecord(artifacts.wallet)).flush();

        if (artifacts.opening === null) return;

        if (artifacts.ledgerEntry === null) {
          throw new Error("Opening transaction requires a ledger entry");
        }

        await transactionalEm
          .persist(wagerTransactionToRecord(artifacts.opening))
          .flush();
        transactionalEm.persist([
          walletLedgerEntryToRecord(artifacts.ledgerEntry),
          ...artifacts.outboxMessages.map(outboxMessageToRecord),
        ]);
        await transactionalEm.flush();
      });
    } catch (error) {
      if (
        error instanceof UniqueConstraintViolationException &&
        violatesPlayerCurrencyConstraint(error)
      ) {
        throw new WalletAlreadyExistsError();
      }
      if (isTransientPostgresFailure(error)) {
        throw new WalletCreationUnavailableError();
      }
      throw error;
    } finally {
      em.clear();
    }
  }
}
