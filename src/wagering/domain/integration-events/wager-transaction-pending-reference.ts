import {
  IntegrationEvent,
  InvalidIntegrationEventError,
  type JsonObject,
} from "../../../shared/domain/integration-event";
import type { WagerTransaction } from "../wager-transaction";
import type { WagerTransactionKind } from "../wager-transaction-kind";
import { WagerTransactionStatus } from "../wager-transaction-status";

interface WagerTransactionPendingReferencePayload extends JsonObject {
  readonly transactionId: string;
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly walletId: string;
  readonly playerId: string;
  readonly kind: WagerTransactionKind;
  readonly referenceExternalTransactionId: string;
  readonly money: { readonly amount: string; readonly currency: string };
  readonly pendingAt: string;
}

export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionPendingReferencePayload> {
  static readonly EVENT_TYPE = "wager.transaction.pending-reference.v1";

  private constructor(props: {
    id: string;
    transaction: WagerTransaction;
  }) {
    const referenceExternalTransactionId =
      props.transaction.referenceExternalTransactionId;
    if (
      props.transaction.status !== WagerTransactionStatus.PENDING_REFERENCE ||
      referenceExternalTransactionId === null ||
      props.transaction.providerId === null ||
      props.transaction.externalTransactionId === null
    ) {
      throw new InvalidIntegrationEventError(
        "Pending reference event requires a transaction awaiting a reference",
      );
    }
    const pendingAt = props.transaction.updatedAt;
    super({
      id: props.id,
      aggregateId: props.transaction.id,
      eventType: WagerTransactionPendingReference.EVENT_TYPE,
      occurredAt: pendingAt,
      payload: {
        transactionId: props.transaction.id,
        providerId: props.transaction.providerId,
        externalTransactionId: props.transaction.externalTransactionId,
        walletId: props.transaction.walletId,
        playerId: props.transaction.playerId,
        kind: props.transaction.kind,
        referenceExternalTransactionId,
        money: {
          amount: props.transaction.money.toJSON().amount,
          currency: props.transaction.money.currency,
        },
        pendingAt: pendingAt.toISOString(),
      },
    });
  }

  static fromTransaction(
    id: string,
    transaction: WagerTransaction,
  ): WagerTransactionPendingReference {
    return new WagerTransactionPendingReference({ id, transaction });
  }
}
