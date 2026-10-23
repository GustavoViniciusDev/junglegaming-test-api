import { Migration } from "@mikro-orm/migrations";

export class Migration20261022000003 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      alter table wager_transactions
        add column reference_retry_attempts integer not null default 0,
        add column reference_next_attempt_at timestamptz;
    `);
    this.addSql(`
      update wager_transactions
      set reference_next_attempt_at = updated_at
      where status = 'PENDING_REFERENCE';
    `);
    this.addSql(`
      alter table wager_transactions
        add constraint wager_transactions_reference_retry_attempts_nonnegative
          check (reference_retry_attempts >= 0),
        add constraint wager_transactions_reference_retry_schedule check (
          (status = 'PENDING_REFERENCE' and reference_next_attempt_at is not null)
          or (status <> 'PENDING_REFERENCE' and reference_next_attempt_at is null)
        );
    `);
    this.addSql(`
      create index wager_transactions_reference_retry_due_idx
      on wager_transactions (reference_next_attempt_at, created_at, id)
      where status = 'PENDING_REFERENCE';
    `);
  }

  override async down(): Promise<void> {
    this.addSql("drop index wager_transactions_reference_retry_due_idx;");
    this.addSql(`
      alter table wager_transactions
        drop constraint wager_transactions_reference_retry_schedule,
        drop constraint wager_transactions_reference_retry_attempts_nonnegative,
        drop column reference_next_attempt_at,
        drop column reference_retry_attempts;
    `);
  }
}
