import { Money } from "../../shared/domain/money";
import {
  OutboxMessage,
  type OutboxMessageState,
} from "../../outbox/domain/outbox-message";
import type { LedgerDirection } from "../../wallet/domain/ledger-direction";
import { Wallet, type WalletState } from "../../wallet/domain/wallet";
import {
  WalletLedgerEntry,
  type WalletLedgerEntryState,
} from "../../wallet/domain/wallet-ledger-entry";
import type {
  WagerTransactionFailureCode,
  WagerTransactionRejectionCode,
} from "../../wagering/domain/wager-transaction-failure-code";
import type { WagerTransactionKind } from "../../wagering/domain/wager-transaction-kind";
import type { WagerTransactionStatus } from "../../wagering/domain/wager-transaction-status";
import {
  WagerTransaction,
  type WagerTransactionState,
} from "../../wagering/domain/wager-transaction";
import {
  WagerTransactionRecord,
  WalletLedgerEntryRecord,
  WalletRecord,
  OutboxMessageRecord,
} from "./entities";

export function walletToRecord(wallet: Wallet): WalletRecord {
  return Object.assign(new WalletRecord(), {
    id: wallet.id,
    playerId: wallet.playerId,
    currency: wallet.currency,
    balance: wallet.balance.toJSON().amount,
    version: wallet.version,
    createdAt: wallet.createdAt,
    updatedAt: wallet.updatedAt,
  });
}

export function walletFromRecord(record: WalletRecord): Wallet {
  const state: WalletState = {
    id: record.id,
    playerId: record.playerId,
    currency: record.currency,
    balance: Money.from({ amount: record.balance, currency: record.currency }),
    version: record.version,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
  return Wallet.rehydrate(state);
}

export function wagerTransactionToRecord(
  transaction: WagerTransaction,
): WagerTransactionRecord {
  return Object.assign(new WagerTransactionRecord(), {
    id: transaction.id,
    providerId: transaction.providerId,
    externalTransactionId: transaction.externalTransactionId,
    idempotencyKey: transaction.idempotencyKey,
    payloadHash: transaction.payloadHash,
    walletId: transaction.walletId,
    playerId: transaction.playerId,
    roundId: transaction.roundId,
    gameId: transaction.gameId,
    kind: transaction.kind,
    status: transaction.status,
    amount: transaction.money.toJSON().amount,
    resultingBalance: transaction.resultingBalance?.toJSON().amount ?? null,
    currency: transaction.money.currency,
    referenceExternalTransactionId: transaction.referenceExternalTransactionId,
    referenceTransactionId: transaction.referenceTransactionId,
    failureCode: transaction.failureCode,
    processedAt: transaction.processedAt,
    referenceRetryAttempts: 0,
    referenceNextAttemptAt:
      transaction.status === "PENDING_REFERENCE" ? transaction.updatedAt : null,
    createdAt: transaction.createdAt,
    updatedAt: transaction.updatedAt,
  });
}

export function wagerTransactionFromRecord(
  record: WagerTransactionRecord,
): WagerTransaction {
  const state: WagerTransactionState = {
    id: record.id,
    providerId: record.providerId,
    externalTransactionId: record.externalTransactionId,
    idempotencyKey: record.idempotencyKey,
    payloadHash: record.payloadHash,
    walletId: record.walletId,
    playerId: record.playerId,
    roundId: record.roundId,
    gameId: record.gameId,
    kind: record.kind as WagerTransactionKind,
    status: record.status as WagerTransactionStatus,
    money: Money.from({ amount: record.amount, currency: record.currency }),
    resultingBalance:
      record.resultingBalance === null
        ? null
        : Money.from({
            amount: record.resultingBalance,
            currency: record.currency,
          }),
    referenceExternalTransactionId: record.referenceExternalTransactionId,
    referenceTransactionId: record.referenceTransactionId,
    failureCode: record.failureCode as
      | WagerTransactionRejectionCode
      | WagerTransactionFailureCode
      | null,
    processedAt: record.processedAt,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
  return WagerTransaction.rehydrate(state);
}

export function walletLedgerEntryToRecord(
  entry: WalletLedgerEntry,
): WalletLedgerEntryRecord {
  return Object.assign(new WalletLedgerEntryRecord(), {
    id: entry.id,
    walletId: entry.walletId,
    transactionId: entry.transactionId,
    direction: entry.direction,
    amount: entry.money.toJSON().amount,
    currency: entry.money.currency,
    balanceBefore: entry.balanceBefore.toJSON().amount,
    balanceAfter: entry.balanceAfter.toJSON().amount,
    createdAt: entry.createdAt,
  });
}

export function walletLedgerEntryFromRecord(
  record: WalletLedgerEntryRecord,
): WalletLedgerEntry {
  const state: WalletLedgerEntryState = {
    id: record.id,
    walletId: record.walletId,
    transactionId: record.transactionId,
    direction: record.direction as LedgerDirection,
    money: Money.from({ amount: record.amount, currency: record.currency }),
    balanceBefore: Money.from({
      amount: record.balanceBefore,
      currency: record.currency,
    }),
    balanceAfter: Money.from({
      amount: record.balanceAfter,
      currency: record.currency,
    }),
    createdAt: record.createdAt,
  };
  return WalletLedgerEntry.rehydrate(state);
}

export function outboxMessageToRecord(
  message: OutboxMessage,
): OutboxMessageRecord {
  return Object.assign(new OutboxMessageRecord(), {
    id: message.id,
    aggregateId: message.aggregateId,
    eventType: message.eventType,
    payload: message.payload,
    occurredAt: message.occurredAt,
    attempts: message.attempts,
    nextAttemptAt: message.nextAttemptAt,
    publishedAt: message.publishedAt,
  });
}

export function outboxMessageFromRecord(
  record: OutboxMessageRecord,
): OutboxMessage {
  const state: OutboxMessageState = {
    id: record.id,
    aggregateId: record.aggregateId,
    eventType: record.eventType,
    payload: record.payload,
    occurredAt: record.occurredAt,
    attempts: record.attempts,
    nextAttemptAt: record.nextAttemptAt,
    publishedAt: record.publishedAt,
  };
  return OutboxMessage.rehydrate(state);
}
