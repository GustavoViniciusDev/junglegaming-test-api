import { MikroORM } from "@mikro-orm/postgresql";
import { Inject, Injectable } from "@nestjs/common";
import { wagerTransactionFromRecord } from "../../infrastructure/database/domain-mappers";
import { WagerTransactionRecord } from "../../infrastructure/database/entities";
import { isTransientPostgresFailure } from "../../infrastructure/database/transient-postgres-failure";
import { InfrastructureUnavailableError } from "../../shared/application/infrastructure-unavailable-error";
import type { WagerTransactionReadStore } from "../application/read-wager-transaction";
import type { WagerTransaction } from "../domain/wager-transaction";

@Injectable()
export class MikroOrmWagerTransactionReadStore
  implements WagerTransactionReadStore
{
  constructor(@Inject(MikroORM) private readonly orm: MikroORM) {}

  async findById(transactionId: string): Promise<WagerTransaction | null> {
    return this.read(async (em) => {
      const record = await em.findOne(WagerTransactionRecord, {
        id: transactionId,
      });
      return record === null ? null : wagerTransactionFromRecord(record);
    });
  }

  async findByProviderIdentity(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | null> {
    return this.read(async (em) => {
      const record = await em.findOne(WagerTransactionRecord, {
        providerId,
        externalTransactionId,
      });
      return record === null ? null : wagerTransactionFromRecord(record);
    });
  }

  private async read<T>(
    query: (em: ReturnType<MikroORM["em"]["fork"]>) => Promise<T>,
  ): Promise<T> {
    const em = this.orm.em.fork({ clear: true });
    try {
      return await query(em);
    } catch (error) {
      if (isTransientPostgresFailure(error)) {
        throw new InfrastructureUnavailableError(
          "Wager transaction read is temporarily unavailable",
        );
      }
      throw error;
    } finally {
      em.clear();
    }
  }
}
