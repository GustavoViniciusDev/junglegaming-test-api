import {
  copyJsonObject,
  type IntegrationEvent,
  type JsonObject,
} from "../../shared/domain/integration-event";

export interface OutboxMessageState {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: JsonObject;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt: Date;
  publishedAt: Date | null;
}

export interface OutboxMessageJSON {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: JsonObject;
  occurredAt: string;
  attempts: number;
  nextAttemptAt: string;
  publishedAt: string | null;
}

export class InvalidOutboxMessageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidOutboxMessageError";
  }
}

function isValidDate(value: Date): boolean {
  return value instanceof Date && Number.isFinite(value.getTime());
}

export class OutboxMessage {
  public readonly id: string;
  public readonly aggregateId: string;
  public readonly eventType: string;
  public readonly attempts: number;
  readonly #payload: JsonObject;
  readonly #occurredAt: Date;
  readonly #nextAttemptAt: Date;
  readonly #publishedAt: Date | null;

  private constructor(state: OutboxMessageState) {
    if (
      !state.id.trim() ||
      !state.aggregateId.trim() ||
      !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*(?:\.[a-z][a-z0-9]*(?:-[a-z0-9]+)*)+\.v[1-9][0-9]*$/.test(
        state.eventType,
      )
    ) {
      throw new InvalidOutboxMessageError(
        "Outbox message identifiers and event type must be valid",
      );
    }
    if (
      !isValidDate(state.occurredAt) ||
      !isValidDate(state.nextAttemptAt) ||
      (state.publishedAt !== null && !isValidDate(state.publishedAt))
    ) {
      throw new InvalidOutboxMessageError(
        "Outbox message timestamps must be valid",
      );
    }
    if (
      !Number.isSafeInteger(state.attempts) ||
      state.attempts < 0 ||
      state.attempts > 2_147_483_647
    ) {
      throw new InvalidOutboxMessageError(
        "Outbox message attempts must fit a non-negative PostgreSQL integer",
      );
    }
    this.id = state.id;
    this.aggregateId = state.aggregateId;
    this.eventType = state.eventType;
    this.attempts = state.attempts;
    this.#payload = copyJsonObject(state.payload);
    this.#occurredAt = new Date(state.occurredAt.getTime());
    this.#nextAttemptAt = new Date(state.nextAttemptAt.getTime());
    this.#publishedAt =
      state.publishedAt === null ? null : new Date(state.publishedAt.getTime());
    Object.freeze(this);
  }

  static fromEvent(event: IntegrationEvent): OutboxMessage {
    const occurredAt = event.occurredAt;
    return new OutboxMessage({
      id: event.id,
      aggregateId: event.aggregateId,
      eventType: event.eventType,
      payload: event.payload,
      occurredAt,
      attempts: 0,
      nextAttemptAt: occurredAt,
      publishedAt: null,
    });
  }

  static rehydrate(state: OutboxMessageState): OutboxMessage {
    return new OutboxMessage(state);
  }

  get payload(): JsonObject {
    return this.#payload;
  }

  get occurredAt(): Date {
    return new Date(this.#occurredAt.getTime());
  }

  get nextAttemptAt(): Date {
    return new Date(this.#nextAttemptAt.getTime());
  }

  get publishedAt(): Date | null {
    return this.#publishedAt === null
      ? null
      : new Date(this.#publishedAt.getTime());
  }

  toJSON(): OutboxMessageJSON {
    return {
      id: this.id,
      aggregateId: this.aggregateId,
      eventType: this.eventType,
      payload: copyJsonObject(this.#payload),
      occurredAt: this.#occurredAt.toISOString(),
      attempts: this.attempts,
      nextAttemptAt: this.#nextAttemptAt.toISOString(),
      publishedAt: this.#publishedAt?.toISOString() ?? null,
    };
  }
}
