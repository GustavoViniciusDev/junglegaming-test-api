import { Migration } from "@mikro-orm/migrations";

export class Migration20261022000001 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      create unique index wager_transactions_processed_reversal_unique
      on wager_transactions (reference_transaction_id, kind)
      where status = 'PROCESSED'
        and kind in ('REFUND', 'ROLLBACK')
        and reference_transaction_id is not null;
    `);
  }

  override async down(): Promise<void> {
    this.addSql("drop index wager_transactions_processed_reversal_unique;");
  }
}
