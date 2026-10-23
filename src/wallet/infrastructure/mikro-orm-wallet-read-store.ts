import { MikroORM } from "@mikro-orm/postgresql";
import { Inject, Injectable } from "@nestjs/common";
import {
  walletFromRecord,
  walletLedgerEntryFromRecord,
} from "../../infrastructure/database/domain-mappers";
import {
  WalletLedgerEntryRecord,
  WalletRecord,
} from "../../infrastructure/database/entities";
import { isTransientPostgresFailure } from "../../infrastructure/database/transient-postgres-failure";
import { InfrastructureUnavailableError } from "../../shared/application/infrastructure-unavailable-error";
import type { WalletReadStore } from "../application/read-wallet";
import type { LedgerCursor } from "../../shared/application/ledger-cursor";
import type { Wallet } from "../domain/wallet";
import type { WalletLedgerEntry } from "../domain/wallet-ledger-entry";

interface LedgerRow {
  id: string;
  walletId: string;
  transactionId: string;
  direction: string;
  amount: string;
  currency: string;
  balanceBefore: string;
  balanceAfter: string;
  createdAt: Date | string;
}

@Injectable()
export class MikroOrmWalletReadStore implements WalletReadStore {
  constructor(@Inject(MikroORM) private readonly orm: MikroORM) {}

  async findWallet(walletId: string): Promise<Wallet | null> {
    const em = this.orm.em.fork({ clear: true });
    try {
      const record = await em.findOne(WalletRecord, { id: walletId });
      return record === null ? null : walletFromRecord(record);
    } catch (error) {
      if (isTransientPostgresFailure(error)) {
        throw new InfrastructureUnavailableError(
          "Wallet read is temporarily unavailable",
        );
      }
      throw error;
    } finally {
      em.clear();
    }
  }

  async findLedgerEntries(input: {
    walletId: string;
    cursor: LedgerCursor | null;
    take: number;
  }): Promise<WalletLedgerEntry[]> {
    const em = this.orm.em.fork({ clear: true });
    try {
      const cursorCondition =
        input.cursor === null
          ? ""
          : "and (created_at < ? or (created_at = ? and id < ?))";
      const parameters =
        input.cursor === null
          ? [input.walletId, input.take]
          : [
              input.walletId,
              input.cursor.createdAt,
              input.cursor.createdAt,
              input.cursor.id,
              input.take,
            ];
      const rows = (await em.getConnection().execute(
        `select id, wallet_id as "walletId", transaction_id as "transactionId",
                direction, amount, currency, balance_before as "balanceBefore",
                balance_after as "balanceAfter", created_at as "createdAt"
         from wallet_ledger_entries
         where wallet_id = ? ${cursorCondition}
         order by created_at desc, id desc
         limit ?`,
        parameters,
      )) as LedgerRow[];
      return rows.map((row) =>
        walletLedgerEntryFromRecord(
          Object.assign(new WalletLedgerEntryRecord(), {
            ...row,
            createdAt: new Date(row.createdAt),
          }),
        ),
      );
    } catch (error) {
      if (isTransientPostgresFailure(error)) {
        throw new InfrastructureUnavailableError(
          "Wallet ledger read is temporarily unavailable",
        );
      }
      throw error;
    } finally {
      em.clear();
    }
  }
}
