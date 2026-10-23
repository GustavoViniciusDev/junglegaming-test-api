import { Money } from "../../shared/domain/money";
import { isWithinPersistableMoneyRange } from "../../shared/domain/persistable-money-range";
import {
  WagerTransactionFailureCode,
  WagerTransactionRejectionCode,
} from "./wager-transaction-failure-code";
import { WagerTransactionKind } from "./wager-transaction-kind";
import { WagerTransactionStatus } from "./wager-transaction-status";

export class InvalidWagerTransactionStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidWagerTransactionStateError";
  }
}

export class InvalidWagerTransactionTransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidWagerTransactionTransitionError";
  }
}

export interface WagerTransactionProps {
  id: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  money: Money;
}

export interface CreateWagerTransactionProps extends WagerTransactionProps {
  providerId: string;
  externalTransactionId: string;
  roundId: string;
  gameId: string;
  kind: Exclude<WagerTransactionKind, WagerTransactionKind.OPENING>;
  referenceExternalTransactionId?: string | null;
}

export interface WagerTransactionState extends WagerTransactionProps {
  providerId: string | null;
  externalTransactionId: string | null;
  roundId: string | null;
  gameId: string | null;
  kind: WagerTransactionKind;
  status: WagerTransactionStatus;
  resultingBalance: Money | null;
  referenceExternalTransactionId: string | null;
  referenceTransactionId: string | null;
  failureCode:
    | WagerTransactionRejectionCode
    | WagerTransactionFailureCode
    | null;
  processedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

function isIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isValidDate(value: Date): boolean {
  return value instanceof Date && Number.isFinite(value.getTime());
}

export class WagerTransaction {
  public readonly id: string;
  public readonly providerId: string | null;
  public readonly externalTransactionId: string | null;
  public readonly idempotencyKey: string;
  public readonly payloadHash: string;
  public readonly walletId: string;
  public readonly playerId: string;
  public readonly roundId: string | null;
  public readonly gameId: string | null;
  public readonly kind: WagerTransactionKind;
  public readonly money: Money;
  public readonly referenceExternalTransactionId: string | null;
  readonly #createdAt: Date;
  #resultingBalance: Money | null;
  #status: WagerTransactionStatus;
  #referenceTransactionId: string | null;
  #failureCode:
    | WagerTransactionRejectionCode
    | WagerTransactionFailureCode
    | null;
  #processedAt: Date | null;
  #updatedAt: Date;

  private constructor(state: WagerTransactionState) {
    WagerTransaction.validateState(state);
    this.id = state.id;
    this.providerId = state.providerId;
    this.externalTransactionId = state.externalTransactionId;
    this.idempotencyKey = state.idempotencyKey;
    this.payloadHash = state.payloadHash;
    this.walletId = state.walletId;
    this.playerId = state.playerId;
    this.roundId = state.roundId;
    this.gameId = state.gameId;
    this.kind = state.kind;
    this.money = state.money;
    this.referenceExternalTransactionId = state.referenceExternalTransactionId;
    this.#createdAt = new Date(state.createdAt.getTime());
    this.#status = state.status;
    this.#resultingBalance = state.resultingBalance;
    this.#referenceTransactionId = state.referenceTransactionId;
    this.#failureCode = state.failureCode;
    this.#processedAt =
      state.processedAt === null ? null : new Date(state.processedAt.getTime());
    this.#updatedAt = new Date(state.updatedAt.getTime());
    Object.freeze(this);
  }

  static create(
    props: CreateWagerTransactionProps,
    at: Date = new Date(),
  ): WagerTransaction {
    if (
      !Object.values(WagerTransactionKind).some(
        (kind) => kind !== WagerTransactionKind.OPENING && kind === props.kind,
      )
    ) {
      throw new InvalidWagerTransactionStateError(
        "Provider transaction kind must be BET, WIN, LOSS, REFUND or ROLLBACK",
      );
    }
    return new WagerTransaction({
      ...props,
      status: WagerTransactionStatus.PENDING,
      resultingBalance: null,
      referenceExternalTransactionId:
        props.referenceExternalTransactionId ?? null,
      referenceTransactionId: null,
      failureCode: null,
      processedAt: null,
      createdAt: at,
      updatedAt: at,
    });
  }

  static createOpening(
    props: WagerTransactionProps,
    at: Date = new Date(),
  ): WagerTransaction {
    return new WagerTransaction({
      ...props,
      providerId: null,
      externalTransactionId: null,
      roundId: null,
      gameId: null,
      kind: WagerTransactionKind.OPENING,
      status: WagerTransactionStatus.PENDING,
      resultingBalance: null,
      referenceExternalTransactionId: null,
      referenceTransactionId: null,
      failureCode: null,
      processedAt: null,
      createdAt: at,
      updatedAt: at,
    });
  }

  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(state);
  }

  get status(): WagerTransactionStatus {
    return this.#status;
  }

  get resultingBalance(): Money | null {
    return this.#resultingBalance;
  }

  get referenceTransactionId(): string | null {
    return this.#referenceTransactionId;
  }

  get failureCode():
    | WagerTransactionRejectionCode
    | WagerTransactionFailureCode
    | null {
    return this.#failureCode;
  }

  get processedAt(): Date | null {
    return this.#processedAt === null
      ? null
      : new Date(this.#processedAt.getTime());
  }

  get createdAt(): Date {
    return new Date(this.#createdAt.getTime());
  }

  get updatedAt(): Date {
    return new Date(this.#updatedAt.getTime());
  }

  isTerminal(): boolean {
    return (
      this.#status === WagerTransactionStatus.PROCESSED ||
      this.#status === WagerTransactionStatus.REJECTED ||
      this.#status === WagerTransactionStatus.FAILED
    );
  }

  markProcessed(resultingBalance: Money, at: Date = new Date()): void {
    this.#transition(
      WagerTransactionStatus.PROCESSED,
      null,
      at,
      resultingBalance,
    );
  }

  reject(
    failureCode: WagerTransactionRejectionCode,
    at: Date = new Date(),
  ): void {
    if (!Object.values(WagerTransactionRejectionCode).includes(failureCode)) {
      throw new InvalidWagerTransactionTransitionError(
        "Rejection requires a supported business failure code",
      );
    }
    this.#transition(WagerTransactionStatus.REJECTED, failureCode, at);
  }

  fail(failureCode: WagerTransactionFailureCode, at: Date = new Date()): void {
    if (!Object.values(WagerTransactionFailureCode).includes(failureCode)) {
      throw new InvalidWagerTransactionTransitionError(
        "Failure requires a supported permanent technical failure code",
      );
    }
    this.#transition(WagerTransactionStatus.FAILED, failureCode, at);
  }

  markPendingReference(at: Date = new Date()): void {
    if (
      this.#status !== WagerTransactionStatus.PENDING ||
      this.referenceExternalTransactionId === null ||
      this.#referenceTransactionId !== null
    ) {
      throw new InvalidWagerTransactionTransitionError(
        "Only a pending transaction with an unresolved external reference can wait for a reference",
      );
    }
    this.#transition(WagerTransactionStatus.PENDING_REFERENCE, null, at);
  }

  resolveReference(transactionId: string, at: Date = new Date()): void {
    this.#assertMutable();
    if (
      !isIdentifier(transactionId) ||
      this.referenceExternalTransactionId === null
    ) {
      throw new InvalidWagerTransactionTransitionError(
        "Reference resolution requires a non-empty transaction id and an external reference",
      );
    }
    this.#validateTransitionTime(at);
    if (this.#referenceTransactionId !== null) {
      if (this.#referenceTransactionId !== transactionId) {
        throw new InvalidWagerTransactionTransitionError(
          "A resolved reference cannot be replaced with another transaction",
        );
      }
      return;
    }
    const updatedAt = new Date(at.getTime());
    this.#referenceTransactionId = transactionId;
    this.#updatedAt = updatedAt;
  }

  #assertMutable(): void {
    if (this.isTerminal()) {
      throw new InvalidWagerTransactionTransitionError(
        "Terminal transactions cannot change state",
      );
    }
  }

  #validateTransitionTime(at: Date): void {
    if (!isValidDate(at) || at.getTime() < this.#updatedAt.getTime()) {
      throw new InvalidWagerTransactionTransitionError(
        "Transition timestamp must be valid and not precede the last update",
      );
    }
  }

  #transition(
    status: WagerTransactionStatus,
    failureCode:
      | WagerTransactionRejectionCode
      | WagerTransactionFailureCode
      | null,
    at: Date,
    resultingBalance: Money | null = null,
  ): void {
    this.#assertMutable();
    this.#validateTransitionTime(at);
    if (status === WagerTransactionStatus.PROCESSED) {
      this.#validateResultingBalance(resultingBalance);
    } else if (resultingBalance !== null) {
      throw new InvalidWagerTransactionTransitionError(
        "Only processed transactions can record a resulting balance",
      );
    }
    const updatedAt = new Date(at.getTime());
    const processedAt =
      status === WagerTransactionStatus.PENDING_REFERENCE
        ? null
        : new Date(at.getTime());
    this.#status = status;
    this.#resultingBalance = resultingBalance;
    this.#failureCode = failureCode;
    this.#processedAt = processedAt;
    this.#updatedAt = updatedAt;
  }

  #validateResultingBalance(
    resultingBalance: Money | null,
  ): asserts resultingBalance is Money {
    if (!(resultingBalance instanceof Money)) {
      throw new InvalidWagerTransactionTransitionError(
        "Processing requires a resulting balance",
      );
    }
    if (resultingBalance.currency !== this.money.currency) {
      throw new InvalidWagerTransactionTransitionError(
        "Resulting balance currency must match transaction money",
      );
    }
    if (
      resultingBalance.isNegative() ||
      !isWithinPersistableMoneyRange(resultingBalance)
    ) {
      throw new InvalidWagerTransactionTransitionError(
        "Resulting balance must be non-negative and within the persistable range",
      );
    }
  }

  private static validateState(state: WagerTransactionState): void {
    for (const field of [
      "id",
      "idempotencyKey",
      "payloadHash",
      "walletId",
      "playerId",
    ] as const) {
      if (!isIdentifier(state[field])) {
        throw new InvalidWagerTransactionStateError(
          `${field} must be a non-empty identifier`,
        );
      }
    }
    if (
      !Object.values(WagerTransactionKind).includes(state.kind) ||
      !Object.values(WagerTransactionStatus).includes(state.status)
    ) {
      throw new InvalidWagerTransactionStateError(
        "Transaction kind and status must be supported values",
      );
    }
    if (!(state.money instanceof Money)) {
      throw new InvalidWagerTransactionStateError(
        "Transaction money must be a Money value",
      );
    }
    if (
      state.resultingBalance !== null &&
      (!(state.resultingBalance instanceof Money) ||
        state.resultingBalance.currency !== state.money.currency ||
        state.resultingBalance.isNegative() ||
        !isWithinPersistableMoneyRange(state.resultingBalance))
    ) {
      throw new InvalidWagerTransactionStateError(
        "Resulting balance must use transaction currency and fit the persistable non-negative range",
      );
    }
    if (state.money.isNegative()) {
      throw new InvalidWagerTransactionStateError(
        "Transaction money must not be negative",
      );
    }
    if (!isWithinPersistableMoneyRange(state.money)) {
      throw new InvalidWagerTransactionStateError(
        "Transaction money exceeds the persistable monetary range",
      );
    }
    for (const field of [
      "providerId",
      "externalTransactionId",
      "roundId",
      "gameId",
    ] as const) {
      if (
        state.kind === WagerTransactionKind.OPENING
          ? state[field] !== null
          : !isIdentifier(state[field])
      ) {
        throw new InvalidWagerTransactionStateError(
          `${field} must be null for OPENING and non-empty for provider transactions`,
        );
      }
    }
    const hasReference = state.referenceExternalTransactionId !== null;
    const supportsReference =
      state.kind === WagerTransactionKind.WIN ||
      state.kind === WagerTransactionKind.REFUND ||
      state.kind === WagerTransactionKind.ROLLBACK;
    const requiresReference =
      state.kind === WagerTransactionKind.REFUND ||
      state.kind === WagerTransactionKind.ROLLBACK;
    if (
      (hasReference &&
        (!supportsReference ||
          !isIdentifier(state.referenceExternalTransactionId))) ||
      (requiresReference && !hasReference) ||
      (state.referenceTransactionId !== null &&
        (!hasReference || !isIdentifier(state.referenceTransactionId)))
    ) {
      throw new InvalidWagerTransactionStateError(
        "Transaction reference identifiers are inconsistent with its kind",
      );
    }
    if (
      state.status === WagerTransactionStatus.PENDING_REFERENCE &&
      !hasReference
    ) {
      throw new InvalidWagerTransactionStateError(
        "Pending reference status requires an external reference",
      );
    }
    if (
      !isValidDate(state.createdAt) ||
      !isValidDate(state.updatedAt) ||
      state.updatedAt.getTime() < state.createdAt.getTime()
    ) {
      throw new InvalidWagerTransactionStateError(
        "Transaction timestamps must be valid and ordered",
      );
    }
    if (
      state.status === WagerTransactionStatus.PENDING ||
      state.status === WagerTransactionStatus.PENDING_REFERENCE
    ) {
      if (
        state.failureCode !== null ||
        state.processedAt !== null ||
        state.resultingBalance !== null
      ) {
        throw new InvalidWagerTransactionStateError(
          "Pending transactions cannot have a failure code, completion timestamp or resulting balance",
        );
      }
      return;
    }
    if (
      state.processedAt === null ||
      !isValidDate(state.processedAt) ||
      state.processedAt.getTime() !== state.updatedAt.getTime()
    ) {
      throw new InvalidWagerTransactionStateError(
        "Terminal transactions require a valid completion timestamp matching updatedAt",
      );
    }
    const validFailureCode =
      state.status === WagerTransactionStatus.PROCESSED
        ? state.failureCode === null && state.resultingBalance !== null
        : state.status === WagerTransactionStatus.REJECTED
          ? state.resultingBalance === null &&
            Object.values(WagerTransactionRejectionCode).some(
              (code) => code === state.failureCode,
            )
          : state.resultingBalance === null &&
            Object.values(WagerTransactionFailureCode).some(
              (code) => code === state.failureCode,
            );
    if (!validFailureCode) {
      throw new InvalidWagerTransactionStateError(
        "Transaction failure code is inconsistent with its status",
      );
    }
  }
}
