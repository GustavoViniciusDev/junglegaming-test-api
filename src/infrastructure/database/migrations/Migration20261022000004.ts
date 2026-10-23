import { Migration } from "@mikro-orm/migrations";

export class Migration20261022000004 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      create index wallet_ledger_entries_wallet_created_id_idx
      on wallet_ledger_entries (wallet_id, created_at desc, id desc);
    `);
  }

  override async down(): Promise<void> {
    this.addSql("drop index wallet_ledger_entries_wallet_created_id_idx;");
  }
}
