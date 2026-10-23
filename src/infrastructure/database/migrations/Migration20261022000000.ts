import { Migration } from "@mikro-orm/migrations";

export class Migration20261022000000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      create table wallets (
        id text primary key,
        player_id text not null,
        currency text not null,
        balance numeric(20,2) not null,
        version bigint not null,
        created_at timestamptz not null,
        updated_at timestamptz not null,
        constraint wallets_player_currency_unique unique (player_id, currency),
        constraint wallets_id_player_currency_unique unique (id, player_id, currency),
        constraint wallets_id_currency_unique unique (id, currency),
        constraint wallets_balance_nonnegative check (balance >= 0),
        constraint wallets_version_valid check (version between 1 and 9007199254740991),
        constraint wallets_currency_format check (currency ~ '^[A-Z]{3}$'),
        constraint wallets_timestamps_ordered check (updated_at >= created_at),
        constraint wallets_id_nonempty check (length(btrim(id)) > 0),
        constraint wallets_player_id_nonempty check (length(btrim(player_id)) > 0)
      );
    `);

    // Idempotency keys are global; nullable provider keys allow distinct internal OPENING rows.
    this.addSql(`
      create table wager_transactions (
        id text primary key,
        provider_id text,
        external_transaction_id text,
        idempotency_key text not null,
        payload_hash text not null,
        wallet_id text not null,
        player_id text not null,
        round_id text,
        game_id text,
        kind text not null,
        status text not null,
        amount numeric(20,2) not null,
        resulting_balance numeric(20,2),
        currency text not null,
        reference_external_transaction_id text,
        reference_transaction_id text references wager_transactions(id) on delete restrict,
        failure_code text,
        processed_at timestamptz,
        created_at timestamptz not null,
        updated_at timestamptz not null,
        constraint wager_transactions_idempotency_key_unique unique (idempotency_key),
        constraint wager_transactions_provider_external_unique unique (provider_id, external_transaction_id),
        constraint wager_transactions_id_wallet_currency_unique unique (id, wallet_id, currency),
        constraint wager_transactions_wallet_identity_fk foreign key (wallet_id, player_id, currency)
          references wallets (id, player_id, currency) on delete restrict,
        constraint wager_transactions_kind_valid check (kind in ('OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK')),
        constraint wager_transactions_status_valid check (status in ('PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED')),
        constraint wager_transactions_amount_nonnegative check (amount >= 0),
        constraint wager_transactions_resulting_balance_nonnegative check (resulting_balance is null or resulting_balance >= 0),
        constraint wager_transactions_currency_format check (currency ~ '^[A-Z]{3}$'),
        constraint wager_transactions_metadata check (
          (kind = 'OPENING' and provider_id is null and external_transaction_id is null and round_id is null and game_id is null)
          or (kind <> 'OPENING' and provider_id is not null and external_transaction_id is not null
              and round_id is not null and game_id is not null and length(btrim(provider_id)) > 0
              and length(btrim(external_transaction_id)) > 0 and length(btrim(round_id)) > 0
              and length(btrim(game_id)) > 0)
        ),
        constraint wager_transactions_reference check (
          (reference_external_transaction_id is null or
            (kind in ('WIN', 'REFUND', 'ROLLBACK') and length(btrim(reference_external_transaction_id)) > 0))
          and (kind not in ('REFUND', 'ROLLBACK') or reference_external_transaction_id is not null)
          and (reference_transaction_id is null or reference_external_transaction_id is not null)
        ),
        constraint wager_transactions_status_fields check (
          (status in ('PENDING', 'PENDING_REFERENCE') and processed_at is null and failure_code is null and resulting_balance is null)
          or (status = 'PROCESSED' and processed_at is not null and failure_code is null and resulting_balance is not null)
          or (status = 'REJECTED' and processed_at is not null and failure_code is not null and resulting_balance is null and failure_code in (
            'INSUFFICIENT_FUNDS', 'REVERSAL_WOULD_CAUSE_NEGATIVE_BALANCE', 'REFERENCE_NOT_FOUND',
            'INVALID_REFERENCE_KIND', 'REFERENCE_PROVIDER_MISMATCH', 'REFERENCE_PLAYER_MISMATCH',
            'REFERENCE_WALLET_MISMATCH', 'REFERENCE_CURRENCY_MISMATCH', 'REFERENCE_ROUND_MISMATCH',
            'REFERENCE_AMOUNT_MISMATCH', 'ALREADY_REFUNDED', 'ALREADY_ROLLED_BACK'))
          or (status = 'FAILED' and processed_at is not null and failure_code is not null and resulting_balance is null
              and failure_code = 'PERMANENT_PROCESSING_ERROR')
        ),
        constraint wager_transactions_pending_reference check (status <> 'PENDING_REFERENCE' or reference_external_transaction_id is not null),
        constraint wager_transactions_timestamps_ordered check (
          updated_at >= created_at and (processed_at is null or processed_at = updated_at)
        ),
        constraint wager_transactions_ids_nonempty check (
          length(btrim(id)) > 0 and length(btrim(idempotency_key)) > 0 and length(btrim(payload_hash)) > 0
          and length(btrim(wallet_id)) > 0 and length(btrim(player_id)) > 0
        )
      );
    `);

    this.addSql(`
      create table wallet_ledger_entries (
        id text primary key,
        wallet_id text not null,
        transaction_id text not null,
        direction text not null,
        amount numeric(20,2) not null,
        currency text not null,
        balance_before numeric(20,2) not null,
        balance_after numeric(20,2) not null,
        created_at timestamptz not null,
        constraint wallet_ledger_entries_transaction_wallet_unique unique (transaction_id, wallet_id),
        constraint wallet_ledger_entries_wallet_currency_fk foreign key (wallet_id, currency)
          references wallets (id, currency) on delete restrict,
        constraint wallet_ledger_entries_transaction_wallet_currency_fk foreign key (transaction_id, wallet_id, currency)
          references wager_transactions (id, wallet_id, currency) on delete restrict,
        constraint wallet_ledger_entries_direction_valid check (direction in ('CREDIT', 'DEBIT')),
        constraint wallet_ledger_entries_amount_positive check (amount > 0),
        constraint wallet_ledger_entries_balances_nonnegative check (balance_before >= 0 and balance_after >= 0),
        constraint wallet_ledger_entries_currency_format check (currency ~ '^[A-Z]{3}$'),
        constraint wallet_ledger_entries_arithmetic check (
          (direction = 'CREDIT' and balance_after = balance_before + amount)
          or (direction = 'DEBIT' and balance_after = balance_before - amount)
        ),
        constraint wallet_ledger_entries_id_nonempty check (length(btrim(id)) > 0)
      );
    `);

    this.addSql(`
      create function reject_wallet_ledger_entry_mutation() returns trigger language plpgsql as $$
      begin
        raise exception 'Wallet ledger entries are immutable' using errcode = 'check_violation';
      end;
      $$;
    `);
    this.addSql(`
      create trigger wallet_ledger_entries_immutable
      before update or delete on wallet_ledger_entries
      for each row execute function reject_wallet_ledger_entry_mutation();
    `);

    this.addSql(`
      create table inbox_messages (
        message_id text not null,
        consumer_name text not null,
        payload_hash text not null,
        received_at timestamptz not null,
        processed_at timestamptz,
        constraint inbox_messages_pkey primary key (consumer_name, message_id),
        constraint inbox_messages_ids_nonempty check (
          length(btrim(message_id)) > 0 and length(btrim(consumer_name)) > 0 and length(btrim(payload_hash)) > 0
        ),
        constraint inbox_messages_timestamps_ordered check (processed_at is null or processed_at >= received_at)
      );
    `);

    this.addSql(`
      create table outbox_messages (
        id text primary key,
        aggregate_id text not null,
        event_type text not null,
        payload jsonb not null,
        occurred_at timestamptz not null,
        attempts integer not null default 0,
        next_attempt_at timestamptz not null,
        published_at timestamptz,
        constraint outbox_messages_attempts_nonnegative check (attempts >= 0),
        constraint outbox_messages_ids_nonempty check (
          length(btrim(id)) > 0 and length(btrim(aggregate_id)) > 0 and length(btrim(event_type)) > 0
        ),
        constraint outbox_messages_timestamps_ordered check (published_at is null or published_at >= occurred_at)
      );
    `);
    this.addSql(`
      create index outbox_messages_retry_due_idx on outbox_messages (next_attempt_at, id)
      where published_at is null;
    `);
  }

  override async down(): Promise<void> {
    this.addSql("drop table outbox_messages;");
    this.addSql("drop table inbox_messages;");
    this.addSql(
      "drop trigger wallet_ledger_entries_immutable on wallet_ledger_entries;",
    );
    this.addSql("drop function reject_wallet_ledger_entry_mutation();");
    this.addSql("drop table wallet_ledger_entries;");
    this.addSql("drop table wager_transactions;");
    this.addSql("drop table wallets;");
  }
}
