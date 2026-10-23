import {
  IntegrationEvent,
  InvalidIntegrationEventError,
  type JsonObject,
} from "../../../shared/domain/integration-event";
import type { WagerTransaction } from "../wager-transaction";
import {
  type WagerTransactionFailureCode,
  WagerTransactionRejectionCode,
} from "../wager-transaction-failure-code";
import type { WagerTransactionKind } from "../wager-transaction-kind";
import { WagerTransactionStatus } from "../wager-transaction-status";

interface WagerTransactionRejectedPayload extends JsonObject {
  readonly transactionId: string;
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly walletId: string;
  readonly playerId: string;
  readonly kind: WagerTransactionKind;
  readonly money: { readonly amount: string; readonly currency: string };
  readonly failureCode: WagerTransactionRejectionCode;
  readonly rejectedAt: string;
}

function isRejectionCode(
  code: WagerTransactionRejectionCode | WagerTransactionFailureCode,
): code is WagerTransactionRejectionCode {
  return Object.values(WagerTransactionRejectionCode).some(
    (candidate) => candidate === code,
  );
}

export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionRejectedPayload> {
  static readonly EVENT_TYPE = "wager.transaction.rejected.v1";

  private constructor(props: {
    id: string;
    transaction: WagerTransaction;
  }) {
    const rejectedAt = props.transaction.processedAt;
    if (
      props.transaction.status !== WagerTransactionStatus.REJECTED ||
      rejectedAt === null ||
      props.transaction.failureCode === null ||
      props.transaction.providerId === null ||
      props.transaction.externalTransactionId === null
    ) {
      throw new InvalidIntegrationEventError(
        "Rejected event requires a rejected transaction",
      );
    }
    if (!isRejectionCode(props.transaction.failureCode)) {
      throw new InvalidIntegrationEventError(
        "Rejected event requires a business rejection code",
      );
    }
    super({
      id: props.id,
      aggregateId: props.transaction.id,
      eventType: WagerTransactionRejected.EVENT_TYPE,
      occurredAt: rejectedAt,
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
        failureCode: props.transaction.failureCode,
        rejectedAt: rejectedAt.toISOString(),
      },
    });
  }

  static fromTransaction(
    id: string,
    transaction: WagerTransaction,
  ): WagerTransactionRejected {
    return new WagerTransactionRejected({ id, transaction });
  }
}
