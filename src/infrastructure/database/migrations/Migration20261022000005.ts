import { Migration } from "@mikro-orm/migrations";

export class Migration20261022000005 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      create index outbox_messages_unpublished_age_idx
      on outbox_messages (occurred_at, id)
      where published_at is null;
    `);
  }

  override async down(): Promise<void> {
    this.addSql("drop index outbox_messages_unpublished_age_idx;");
  }
}
