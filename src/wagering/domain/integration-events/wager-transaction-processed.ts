import {
  IntegrationEvent,
  InvalidIntegrationEventError,
  type JsonObject,
} from "../../../shared/domain/integration-event";
import type { WagerTransactionKind } from "../wager-transaction-kind";
import type { WagerTransaction } from "../wager-transaction";
import { WagerTransactionStatus } from "../wager-transaction-status";

interface WagerTransactionProcessedPayload extends JsonObject {
  readonly transactionId: string;
  readonly providerId: string | null;
  readonly externalTransactionId: string | null;
  readonly walletId: string;
  readonly playerId: string;
  readonly kind: WagerTransactionKind;
  readonly money: { readonly amount: string; readonly currency: string };
  readonly processedAt: string;
}

export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionProcessedPayload> {
  static readonly EVENT_TYPE = "wager.transaction.processed.v1";

  private constructor(props: {
    id: string;
    transaction: WagerTransaction;
  }) {
    const processedAt = props.transaction.processedAt;
    if (
      props.transaction.status !== WagerTransactionStatus.PROCESSED ||
      processedAt === null
    ) {
      throw new InvalidIntegrationEventError(
        "Processed event requires a processed transaction",
      );
    }
    super({
      id: props.id,
      aggregateId: props.transaction.id,
      eventType: WagerTransactionProcessed.EVENT_TYPE,
      occurredAt: processedAt,
      payload: {
        transactionId: props.transaction.id,
        providerId: props.transaction.providerId,
        externalTransactionId: props.transaction.externalTransactionId,
        walletId: props.transaction.walletId,
        playerId: props.transaction.playerId,
        kind: props.transaction.kind,
        money: {
          amount: props.transaction.money.toJSON().amount,
          currency: props.transaction.money.currency,
        },
        processedAt: processedAt.toISOString(),
      },
    });
  }

  static fromTransaction(
    id: string,
    transaction: WagerTransaction,
  ): WagerTransactionProcessed {
    return new WagerTransactionProcessed({ id, transaction });
  }
}
