import { Money } from "../../../shared/domain/money";
import {
  IntegrationEvent,
  InvalidIntegrationEventError,
  type JsonObject,
} from "../../../shared/domain/integration-event";
import { LedgerDirection } from "../ledger-direction";

interface WalletBalanceChangedPayload extends JsonObject {
  readonly walletId: string;
  readonly playerId: string;
  readonly direction: LedgerDirection;
  readonly money: { readonly amount: string; readonly currency: string };
  readonly balanceBefore: {
    readonly amount: string;
    readonly currency: string;
  };
  readonly balanceAfter: {
    readonly amount: string;
    readonly currency: string;
  };
  readonly transactionId: string;
  readonly occurredAt: string;
}

export interface CreateWalletBalanceChangedProps {
  id: string;
  walletId: string;
  playerId: string;
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  transactionId: string;
  occurredAt: Date;
}

export class WalletBalanceChanged extends IntegrationEvent<WalletBalanceChangedPayload> {
  static readonly EVENT_TYPE = "wallet.balance.changed.v1";

  private constructor(props: CreateWalletBalanceChangedProps) {
    if (
      !props.walletId.trim() ||
      !props.playerId.trim() ||
      !props.transactionId.trim()
    ) {
      throw new InvalidIntegrationEventError(
        "Wallet balance event identifiers must not be empty",
      );
    }
    if (
      props.direction !== LedgerDirection.CREDIT &&
      props.direction !== LedgerDirection.DEBIT
    ) {
      throw new InvalidIntegrationEventError(
        "Wallet balance event direction must be CREDIT or DEBIT",
      );
    }
    if (
      !(props.money instanceof Money) ||
      !(props.balanceBefore instanceof Money) ||
      !(props.balanceAfter instanceof Money) ||
      props.money.currency !== props.balanceBefore.currency ||
      props.money.currency !== props.balanceAfter.currency
    ) {
      throw new InvalidIntegrationEventError(
        "Wallet balance event money must use one currency",
      );
    }
    super({
      id: props.id,
      aggregateId: props.walletId,
      eventType: WalletBalanceChanged.EVENT_TYPE,
      occurredAt: props.occurredAt,
      payload: {
        walletId: props.walletId,
        playerId: props.playerId,
        direction: props.direction,
        money: {
          amount: props.money.toJSON().amount,
          currency: props.money.currency,
        },
        balanceBefore: {
          amount: props.balanceBefore.toJSON().amount,
          currency: props.balanceBefore.currency,
        },
        balanceAfter: {
          amount: props.balanceAfter.toJSON().amount,
          currency: props.balanceAfter.currency,
        },
        transactionId: props.transactionId,
        occurredAt: props.occurredAt.toISOString(),
      },
    });
  }

  static create(props: CreateWalletBalanceChangedProps): WalletBalanceChanged {
    return new WalletBalanceChanged(props);
  }
}
