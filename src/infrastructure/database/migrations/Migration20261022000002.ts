import { Migration } from "@mikro-orm/migrations";

export class Migration20261022000002 extends Migration {
  override async up(): Promise<void> {
    this.addSql(
      "alter table wager_transactions drop constraint wager_transactions_status_fields;",
    );
    this.addSql(`
      alter table wager_transactions add constraint wager_transactions_status_fields check (
        (status in ('PENDING', 'PENDING_REFERENCE') and processed_at is null and failure_code is null and resulting_balance is null)
        or (status = 'PROCESSED' and processed_at is not null and failure_code is null and resulting_balance is not null)
        or (status = 'REJECTED' and processed_at is not null and failure_code is not null and resulting_balance is null and failure_code in (
          'INSUFFICIENT_FUNDS', 'REVERSAL_WOULD_CAUSE_NEGATIVE_BALANCE', 'REFERENCE_NOT_FOUND',
          'INVALID_REFERENCE_KIND', 'REFERENCE_PROVIDER_MISMATCH', 'REFERENCE_PLAYER_MISMATCH',
          'REFERENCE_WALLET_MISMATCH', 'REFERENCE_CURRENCY_MISMATCH', 'REFERENCE_ROUND_MISMATCH',
          'REFERENCE_AMOUNT_MISMATCH', 'REFERENCE_NOT_PROCESSED', 'ALREADY_REFUNDED', 'ALREADY_ROLLED_BACK'))
        or (status = 'FAILED' and processed_at is not null and failure_code is not null and resulting_balance is null
            and failure_code = 'PERMANENT_PROCESSING_ERROR')
      );
    `);
  }

  override async down(): Promise<void> {
    this.addSql(
      "alter table wager_transactions drop constraint wager_transactions_status_fields;",
    );
    this.addSql(`
      alter table wager_transactions add constraint wager_transactions_status_fields check (
        (status in ('PENDING', 'PENDING_REFERENCE') and processed_at is null and failure_code is null and resulting_balance is null)
        or (status = 'PROCESSED' and processed_at is not null and failure_code is null and resulting_balance is not null)
        or (status = 'REJECTED' and processed_at is not null and failure_code is not null and resulting_balance is null and failure_code in (
          'INSUFFICIENT_FUNDS', 'REVERSAL_WOULD_CAUSE_NEGATIVE_BALANCE', 'REFERENCE_NOT_FOUND',
          'INVALID_REFERENCE_KIND', 'REFERENCE_PROVIDER_MISMATCH', 'REFERENCE_PLAYER_MISMATCH',
          'REFERENCE_WALLET_MISMATCH', 'REFERENCE_CURRENCY_MISMATCH', 'REFERENCE_ROUND_MISMATCH',
          'REFERENCE_AMOUNT_MISMATCH', 'ALREADY_REFUNDED', 'ALREADY_ROLLED_BACK'))
        or (status = 'FAILED' and processed_at is not null and failure_code is not null and resulting_balance is null
            and failure_code = 'PERMANENT_PROCESSING_ERROR')
      );
    `);
  }
}
