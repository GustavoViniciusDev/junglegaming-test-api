import { IsolationLevel } from "@mikro-orm/core";
import { MikroORM } from "@mikro-orm/postgresql";
import { Inject, Injectable } from "@nestjs/common";
import { Money } from "../../shared/domain/money";
import { isTransientPostgresFailure } from "../../infrastructure/database/transient-postgres-failure";
import { walletFromRecord } from "../../infrastructure/database/domain-mappers";
import { WalletRecord } from "../../infrastructure/database/entities";
import { InfrastructureUnavailableError } from "../../shared/application/infrastructure-unavailable-error";
import type {
  ReconciliationLedgerEntry,
  WalletReconciliationSnapshot,
  WalletReconciliationStore,
} from "../application/reconcile-wallet";

interface LedgerRow {
  direction: string;
  amount: string;
  currency: string;
  balanceBefore: string;
  balanceAfter: string;
}

@Injectable()
export class MikroOrmWalletReconciliationStore
  implements WalletReconciliationStore
{
  constructor(@Inject(MikroORM) private readonly orm: MikroORM) {}

  async loadSnapshot(
    walletId: string,
  ): Promise<WalletReconciliationSnapshot | null> {
    const em = this.orm.em.fork({ clear: true });
    try {
      return await em.transactional(
        async (transactionalEm) => {
          const walletRecord = await transactionalEm.findOne(WalletRecord, {
            id: walletId,
          });
          if (walletRecord === null) return null;

          const rows = (await transactionalEm.getConnection().execute(
            `select direction, amount, currency,
                    balance_before as "balanceBefore",
                    balance_after as "balanceAfter"
             from wallet_ledger_entries
             where wallet_id = ?
             order by created_at asc, id asc`,
            [walletId],
            "all",
            transactionalEm.getTransactionContext(),
          )) as LedgerRow[];

          const entries: ReconciliationLedgerEntry[] = rows.map((row) => ({
            direction: row.direction,
            money: Money.from({ amount: row.amount, currency: row.currency }),
            balanceBefore: Money.from({
              amount: row.balanceBefore,
              currency: row.currency,
            }),
            balanceAfter: Money.from({
              amount: row.balanceAfter,
              currency: row.currency,
            }),
          }));

          return { wallet: walletFromRecord(walletRecord), entries };
        },
        {
          isolationLevel: IsolationLevel.REPEATABLE_READ,
          readOnly: true,
        },
      );
    } catch (error) {
      if (isTransientPostgresFailure(error)) {
        throw new InfrastructureUnavailableError(
          "Wallet reconciliation is temporarily unavailable",
        );
      }
      throw error;
    } finally {
      em.clear();
    }
  }
}
