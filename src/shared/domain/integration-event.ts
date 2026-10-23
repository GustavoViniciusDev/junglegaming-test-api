export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | readonly JsonValue[];
export type JsonObject = { readonly [key: string]: JsonValue };

export interface IntegrationEventJSON {
  id: string;
  aggregateId: string;
  eventType: string;
  occurredAt: string;
  payload: JsonObject;
}

export class InvalidIntegrationEventError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidIntegrationEventError";
  }
}

export function copyJsonObject<Payload extends JsonObject>(
  value: Payload,
): Payload;
export function copyJsonObject(value: unknown): JsonObject;
export function copyJsonObject(value: unknown): JsonObject {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new InvalidIntegrationEventError(
      "Event payload must be a JSON object",
    );
  }

  const copy = Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, copyJsonValue(item)]),
  );
  return Object.freeze(copy);
}

function copyJsonValue(value: unknown): JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new InvalidIntegrationEventError(
        "Event payload numbers must be finite",
      );
    }
    return value;
  }
  if (Array.isArray(value)) {
    return Object.freeze(value.map(copyJsonValue));
  }
  if (
    typeof value === "object" &&
    Object.getPrototypeOf(value) === Object.prototype
  ) {
    return copyJsonObject(value);
  }
  throw new InvalidIntegrationEventError(
    "Event payload must contain only JSON values",
  );
}

export abstract class IntegrationEvent<
  Payload extends JsonObject = JsonObject,
> {
  public readonly id: string;
  public readonly aggregateId: string;
  public readonly eventType: string;
  readonly #occurredAt: Date;
  readonly #payload: Payload;

  protected constructor(props: {
    id: string;
    aggregateId: string;
    eventType: string;
    occurredAt: Date;
    payload: Payload;
  }) {
    if (!props.id.trim() || !props.aggregateId.trim()) {
      throw new InvalidIntegrationEventError(
        "Event id and aggregate id must not be empty",
      );
    }
    if (
      !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*(?:\.[a-z][a-z0-9]*(?:-[a-z0-9]+)*)+\.v[1-9][0-9]*$/.test(
        props.eventType,
      )
    ) {
      throw new InvalidIntegrationEventError(
        "Event type must use a namespaced versioned identifier",
      );
    }
    if (
      !(props.occurredAt instanceof Date) ||
      !Number.isFinite(props.occurredAt.getTime())
    ) {
      throw new InvalidIntegrationEventError(
        "Event occurrence timestamp must be valid",
      );
    }
    this.id = props.id;
    this.aggregateId = props.aggregateId;
    this.eventType = props.eventType;
    this.#occurredAt = new Date(props.occurredAt.getTime());
    this.#payload = copyJsonObject(props.payload);
    Object.freeze(this);
  }

  get occurredAt(): Date {
    return new Date(this.#occurredAt.getTime());
  }

  get payload(): Payload {
    return this.#payload;
  }

  toJSON(): IntegrationEventJSON {
    return {
      id: this.id,
      aggregateId: this.aggregateId,
      eventType: this.eventType,
      occurredAt: this.#occurredAt.toISOString(),
      payload: copyJsonObject(this.#payload),
    };
  }
}
