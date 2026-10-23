import {
  BigIntType,
  DecimalType,
  Entity,
  PrimaryKey,
  Property,
} from "@mikro-orm/core";
import type { JsonObject } from "../../shared/domain/integration-event";

@Entity({ tableName: "wallets" })
export class WalletRecord {
  @PrimaryKey({ type: "text" })
  id!: string;

  @Property({ type: "text", fieldName: "player_id" })
  playerId!: string;

  @Property({ type: "text" })
  currency!: string;

  @Property({ type: new DecimalType("string"), precision: 20, scale: 2 })
  balance!: string;

  @Property({ type: new BigIntType("number") })
  version!: number;

  @Property({ type: "timestamptz", fieldName: "created_at" })
  createdAt!: Date;

  @Property({ type: "timestamptz", fieldName: "updated_at" })
  updatedAt!: Date;
}

@Entity({ tableName: "wager_transactions" })
export class WagerTransactionRecord {
  @PrimaryKey({ type: "text" })
  id!: string;

  @Property({ type: "text", nullable: true })
  providerId!: string | null;

  @Property({ type: "text", nullable: true })
  externalTransactionId!: string | null;

  @Property({ type: "text" })
  idempotencyKey!: string;

  @Property({ type: "text" })
  payloadHash!: string;

  @Property({ type: "text" })
  walletId!: string;

  @Property({ type: "text" })
  playerId!: string;

  @Property({ type: "text", nullable: true })
  roundId!: string | null;

  @Property({ type: "text", nullable: true })
  gameId!: string | null;

  @Property({ type: "text" })
  kind!: string;

  @Property({ type: "text" })
  status!: string;

  @Property({ type: new DecimalType("string"), precision: 20, scale: 2 })
  amount!: string;

  @Property({
    type: new DecimalType("string"),
    precision: 20,
    scale: 2,
    nullable: true,
    fieldName: "resulting_balance",
  })
  resultingBalance!: string | null;

  @Property({ type: "text" })
  currency!: string;

  @Property({ type: "text", nullable: true })
  referenceExternalTransactionId!: string | null;

  @Property({ type: "text", nullable: true })
  referenceTransactionId!: string | null;

  @Property({ type: "text", nullable: true })
  failureCode!: string | null;

  @Property({ type: "timestamptz", nullable: true })
  processedAt!: Date | null;

  @Property({ type: "integer", fieldName: "reference_retry_attempts" })
  referenceRetryAttempts!: number;

  @Property({
    type: "timestamptz",
    nullable: true,
    fieldName: "reference_next_attempt_at",
  })
  referenceNextAttemptAt!: Date | null;

  @Property({ type: "timestamptz" })
  createdAt!: Date;

  @Property({ type: "timestamptz" })
  updatedAt!: Date;
}

@Entity({ tableName: "wallet_ledger_entries" })
export class WalletLedgerEntryRecord {
  @PrimaryKey({ type: "text" })
  id!: string;

  @Property({ type: "text" })
  walletId!: string;

  @Property({ type: "text" })
  transactionId!: string;

  @Property({ type: "text" })
  direction!: string;

  @Property({ type: new DecimalType("string"), precision: 20, scale: 2 })
  amount!: string;

  @Property({ type: "text" })
  currency!: string;

  @Property({ type: new DecimalType("string"), precision: 20, scale: 2 })
  balanceBefore!: string;

  @Property({ type: new DecimalType("string"), precision: 20, scale: 2 })
  balanceAfter!: string;

  @Property({ type: "timestamptz" })
  createdAt!: Date;
}

@Entity({ tableName: "inbox_messages" })
export class InboxMessageRecord {
  @PrimaryKey({ type: "text" })
  messageId!: string;

  @PrimaryKey({ type: "text" })
  consumerName!: string;

  @Property({ type: "text" })
  payloadHash!: string;

  @Property({ type: "timestamptz" })
  receivedAt!: Date;

  @Property({ type: "timestamptz", nullable: true })
  processedAt!: Date | null;
}

@Entity({ tableName: "outbox_messages" })
export class OutboxMessageRecord {
  @PrimaryKey({ type: "text" })
  id!: string;

  @Property({ type: "text" })
  aggregateId!: string;

  @Property({ type: "text" })
  eventType!: string;

  @Property({ type: "json", columnType: "jsonb" })
  payload!: JsonObject;

  @Property({ type: "timestamptz" })
  occurredAt!: Date;

  @Property({ type: "integer" })
  attempts!: number;

  @Property({ type: "timestamptz" })
  nextAttemptAt!: Date;

  @Property({ type: "timestamptz", nullable: true })
  publishedAt!: Date | null;
}
