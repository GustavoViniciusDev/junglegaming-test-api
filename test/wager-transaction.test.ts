import { describe, expect, test } from "bun:test";
import { Money } from "../src/shared/domain/money";
import {
  WagerTransactionFailureCode,
  WagerTransactionRejectionCode,
} from "../src/wagering/domain/wager-transaction-failure-code";
import { WagerTransactionKind } from "../src/wagering/domain/wager-transaction-kind";
import { WagerTransactionStatus } from "../src/wagering/domain/wager-transaction-status";
import {
  type CreateWagerTransactionProps,
  InvalidWagerTransactionStateError,
  InvalidWagerTransactionTransitionError,
  WagerTransaction,
  type WagerTransactionState,
} from "../src/wagering/domain/wager-transaction";

const createdAt = "2026-01-01T10:00:00.000Z";
const waitingAt = "2026-01-01T10:01:00.000Z";
const resolvedAt = "2026-01-01T10:02:00.000Z";
const completedAt = "2026-01-01T10:03:00.000Z";

function props(
  kind: CreateWagerTransactionProps["kind"] = WagerTransactionKind.BET,
): CreateWagerTransactionProps {
  return {
    id: "transaction-1",
    providerId: "provider-1",
    externalTransactionId: "external-1",
    idempotencyKey: "idempotency-1",
    payloadHash: "opaque-payload-hash",
    walletId: "wallet-1",
    playerId: "player-1",
    roundId: "round-1",
    gameId: "game-1",
    kind,
    money: Money.from({ amount: "20.00", currency: "BRL" }),
    referenceExternalTransactionId:
      kind === WagerTransactionKind.REFUND ||
      kind === WagerTransactionKind.ROLLBACK
        ? "external-original"
        : null,
  };
}

function openingProps() {
  return {
    id: "opening-1",
    walletId: "wallet-1",
    playerId: "player-1",
    idempotencyKey: "opening-idempotency-1",
    payloadHash: "opaque-opening-hash",
    money: Money.zero("BRL"),
  };
}

function transaction(waiting = false): WagerTransaction {
  const result = WagerTransaction.create(
    props(WagerTransactionKind.REFUND),
    new Date(createdAt),
  );
  if (waiting) result.markPendingReference(new Date(waitingAt));
  return result;
}

function state(status = WagerTransactionStatus.PENDING): WagerTransactionState {
  const terminal = [
    WagerTransactionStatus.PROCESSED,
    WagerTransactionStatus.REJECTED,
    WagerTransactionStatus.FAILED,
  ].includes(status);
  return {
    ...props(WagerTransactionKind.REFUND),
    status,
    referenceExternalTransactionId: "external-original",
    referenceTransactionId: null,
    resultingBalance:
      status === WagerTransactionStatus.PROCESSED
        ? Money.from({ amount: "40.00", currency: "BRL" })
        : null,
    failureCode:
      status === WagerTransactionStatus.REJECTED
        ? WagerTransactionRejectionCode.REFERENCE_NOT_FOUND
        : status === WagerTransactionStatus.FAILED
          ? WagerTransactionFailureCode.PERMANENT_PROCESSING_ERROR
          : null,
    processedAt: terminal ? new Date(completedAt) : null,
    createdAt: new Date(createdAt),
    updatedAt: new Date(completedAt),
  };
}

function snapshot(value: WagerTransaction): WagerTransactionState {
  return {
    id: value.id,
    providerId: value.providerId,
    externalTransactionId: value.externalTransactionId,
    idempotencyKey: value.idempotencyKey,
    payloadHash: value.payloadHash,
    walletId: value.walletId,
    playerId: value.playerId,
    roundId: value.roundId,
    gameId: value.gameId,
    kind: value.kind,
    status: value.status,
    resultingBalance: value.resultingBalance,
    money: value.money,
    referenceExternalTransactionId: value.referenceExternalTransactionId,
    referenceTransactionId: value.referenceTransactionId,
    failureCode: value.failureCode,
    processedAt: value.processedAt,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

describe("WagerTransaction creation", () => {
  test("accepts the maximum persistable amount and rejects larger amounts", () => {
    const maximum = Money.from({
      amount: "999999999999999999.99",
      currency: "BRL",
    });
    const oversized = Money.from({
      amount: "1000000000000000000.00",
      currency: "BRL",
    });
    expect(WagerTransaction.create({ ...props(), money: maximum }).money).toBe(
      maximum,
    );
    expect(
      WagerTransaction.createOpening({ ...openingProps(), money: maximum })
        .money,
    ).toBe(maximum);
    expect(
      WagerTransaction.rehydrate({ ...state(), money: maximum }).money,
    ).toBe(maximum);
    expect(() =>
      WagerTransaction.create({ ...props(), money: oversized }),
    ).toThrow(InvalidWagerTransactionStateError);
    expect(() =>
      WagerTransaction.createOpening({ ...openingProps(), money: oversized }),
    ).toThrow(InvalidWagerTransactionStateError);
    expect(() =>
      WagerTransaction.rehydrate({ ...state(), money: oversized }),
    ).toThrow(InvalidWagerTransactionStateError);
  });

  test("rejects negative money across creation and rehydration", () => {
    const negative = Money.from({ amount: "1.00", currency: "BRL" }).negate();
    expect(() =>
      WagerTransaction.create({ ...props(), money: negative }),
    ).toThrow(InvalidWagerTransactionStateError);
    expect(() =>
      WagerTransaction.createOpening({ ...openingProps(), money: negative }),
    ).toThrow(InvalidWagerTransactionStateError);
    expect(() =>
      WagerTransaction.rehydrate({ ...state(), money: negative }),
    ).toThrow(InvalidWagerTransactionStateError);
  });

  test("preserves zero and positive money across creation and rehydration", () => {
    const zero = Money.zero("BRL");
    const positive = Money.from({ amount: "1.00", currency: "BRL" });
    for (const money of [zero, positive]) {
      expect(WagerTransaction.create({ ...props(), money }).money).toBe(money);
      expect(
        WagerTransaction.createOpening({ ...openingProps(), money }).money,
      ).toBe(money);
      expect(WagerTransaction.rehydrate({ ...state(), money }).money).toBe(
        money,
      );
    }
  });
  test.each([
    WagerTransactionKind.BET,
    WagerTransactionKind.WIN,
    WagerTransactionKind.LOSS,
    WagerTransactionKind.REFUND,
    WagerTransactionKind.ROLLBACK,
  ])("creates %s as PENDING with no completion or failure", (kind) => {
    const input = props(kind);
    const value = WagerTransaction.create(input, new Date(createdAt));
    expect(snapshot(value)).toEqual({
      ...input,
      referenceExternalTransactionId:
        input.referenceExternalTransactionId ?? null,
      status: WagerTransactionStatus.PENDING,
      resultingBalance: null,
      referenceTransactionId: null,
      failureCode: null,
      processedAt: null,
      createdAt: new Date(createdAt),
      updatedAt: new Date(createdAt),
    });
    expect(value.isTerminal()).toBe(false);
    expect(value.money).toBe(input.money);
    expect(value.idempotencyKey).toBe(input.idempotencyKey);
    expect(value.payloadHash).toBe("opaque-payload-hash");
  });

  test("creates OPENING internally without invented provider or game identifiers", () => {
    const input = openingProps();
    const value = WagerTransaction.createOpening(input, new Date(createdAt));
    expect(snapshot(value)).toEqual({
      ...input,
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
      createdAt: new Date(createdAt),
      updatedAt: new Date(createdAt),
    });
    expect(value.money).toBe(input.money);
    value.markProcessed(input.money, new Date(completedAt));
    expect(value.status).toBe(WagerTransactionStatus.PROCESSED);
  });

  test("assigns the initial state instead of accepting caller-supplied mutable state", () => {
    const input = {
      ...props(),
      status: WagerTransactionStatus.FAILED,
      failureCode: WagerTransactionFailureCode.PERMANENT_PROCESSING_ERROR,
      processedAt: new Date(completedAt),
      referenceTransactionId: "injected-reference",
    };
    const value = WagerTransaction.create(input, new Date(createdAt));
    expect(value.status).toBe(WagerTransactionStatus.PENDING);
    expect(value.failureCode).toBeNull();
    expect(value.processedAt).toBeNull();
    expect(value.referenceTransactionId).toBeNull();
    expect(value.updatedAt).toEqual(new Date(createdAt));
  });

  test("keeps OPENING metadata internal even when extra provider fields are supplied", () => {
    const input = {
      ...openingProps(),
      ...props(),
      kind: WagerTransactionKind.BET,
      referenceExternalTransactionId: "external-original",
    };
    const value = WagerTransaction.createOpening(input, new Date(createdAt));
    expect(value.kind).toBe(WagerTransactionKind.OPENING);
    expect(value.providerId).toBeNull();
    expect(value.externalTransactionId).toBeNull();
    expect(value.roundId).toBeNull();
    expect(value.gameId).toBeNull();
    expect(value.referenceExternalTransactionId).toBeNull();
  });

  test.each([
    "OPENING",
    "UNKNOWN",
    "bet",
    "",
  ])("rejects unsupported provider kind %j", (kind) => {
    const input = { ...props(), kind };
    // @ts-expect-error Exercise runtime rejection of unsupported provider kinds.
    expect(() => WagerTransaction.create(input)).toThrow(
      InvalidWagerTransactionStateError,
    );
  });

  test.each([
    "id",
    "providerId",
    "externalTransactionId",
    "idempotencyKey",
    "payloadHash",
    "walletId",
    "playerId",
    "roundId",
    "gameId",
  ] as const)("rejects empty and whitespace-only provider %s", (field) => {
    for (const invalid of ["", " ", "\t\n"]) {
      expect(() =>
        WagerTransaction.create({ ...props(), [field]: invalid }),
      ).toThrow(InvalidWagerTransactionStateError);
    }
  });

  test.each([
    "id",
    "walletId",
    "playerId",
    "idempotencyKey",
    "payloadHash",
  ] as const)("requires non-empty internal %s for OPENING", (field) => {
    expect(() =>
      WagerTransaction.createOpening({ ...openingProps(), [field]: " " }),
    ).toThrow(InvalidWagerTransactionStateError);
  });

  test("preserves zero Money and another currency without applying financial rules", () => {
    const amount = Money.zero("EUR");
    const value = WagerTransaction.create({
      ...props(WagerTransactionKind.LOSS),
      money: amount,
    });
    expect(value.money).toBe(amount);
    expect(value.money.toString()).toBe("0.00 EUR");
  });

  test("uses a current creation timestamp when none is supplied", () => {
    const before = Date.now();
    const value = WagerTransaction.create(props());
    expect(value.createdAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(value.createdAt.getTime()).toBeLessThanOrEqual(Date.now());
    expect(value.updatedAt).toEqual(value.createdAt);
    const opening = WagerTransaction.createOpening(openingProps());
    expect(opening.createdAt.getTime()).toBeGreaterThanOrEqual(before);
  });
});

describe("WagerTransaction reference contracts", () => {
  test.each([
    WagerTransactionKind.REFUND,
    WagerTransactionKind.ROLLBACK,
  ])("requires an external reference for %s", (kind) => {
    const { referenceExternalTransactionId: _reference, ...input } =
      props(kind);
    expect(() => WagerTransaction.create(input)).toThrow(
      InvalidWagerTransactionStateError,
    );
    expect(() =>
      WagerTransaction.create({
        ...input,
        referenceExternalTransactionId: null,
      }),
    ).toThrow(InvalidWagerTransactionStateError);
  });

  test.each([
    WagerTransactionKind.WIN,
    WagerTransactionKind.REFUND,
    WagerTransactionKind.ROLLBACK,
  ])("accepts an unresolved external reference for %s", (kind) => {
    const value = WagerTransaction.create({
      ...props(kind),
      referenceExternalTransactionId: "external-original",
    });
    expect(value.referenceExternalTransactionId).toBe("external-original");
    expect(value.referenceTransactionId).toBeNull();
  });

  test("allows WIN without an external reference", () => {
    const value = WagerTransaction.create(props(WagerTransactionKind.WIN));
    expect(value.referenceExternalTransactionId).toBeNull();
  });

  test.each([
    WagerTransactionKind.WIN,
    WagerTransactionKind.REFUND,
    WagerTransactionKind.ROLLBACK,
  ])("rejects empty reference identifiers for %s", (kind) => {
    for (const referenceExternalTransactionId of ["", " ", "\n"]) {
      expect(() =>
        WagerTransaction.create({
          ...props(kind),
          referenceExternalTransactionId,
        }),
      ).toThrow(InvalidWagerTransactionStateError);
    }
  });

  test.each([
    WagerTransactionKind.BET,
    WagerTransactionKind.LOSS,
  ])("rejects external references on %s", (kind) => {
    expect(() =>
      WagerTransaction.create({
        ...props(kind),
        referenceExternalTransactionId: "external-original",
      }),
    ).toThrow(InvalidWagerTransactionStateError);
  });
});

describe("WagerTransaction completion transitions", () => {
  test.each([false, true])("marks PROCESSED from waiting=%s", (waiting) => {
    const value = transaction(waiting);
    value.markProcessed(
      Money.from({ amount: "40.00", currency: "BRL" }),
      new Date(completedAt),
    );
    expect(value.status).toBe(WagerTransactionStatus.PROCESSED);
    expect(value.failureCode).toBeNull();
    expect(value.resultingBalance?.toJSON()).toEqual({
      amount: "40.00",
      currency: "BRL",
    });
    expect(value.processedAt).toEqual(new Date(completedAt));
    expect(value.updatedAt).toEqual(new Date(completedAt));
    expect(value.createdAt).toEqual(new Date(createdAt));
    expect(value.resultingBalance?.toJSON()).toEqual({
      amount: "40.00",
      currency: "BRL",
    });
    expect(value.isTerminal()).toBe(true);
  });

  test("requires a persistable same-currency resulting balance before completion", () => {
    const value = transaction();
    const before = snapshot(value);
    expect(() => {
      // @ts-expect-error A resulting balance is required for processing.
      value.markProcessed(new Date(completedAt));
    }).toThrow(InvalidWagerTransactionTransitionError);
    expect(() => {
      // @ts-expect-error A resulting balance must be a Money value.
      value.markProcessed(null, new Date(completedAt));
    }).toThrow(InvalidWagerTransactionTransitionError);
    expect(() =>
      value.markProcessed(Money.zero("USD"), new Date(completedAt)),
    ).toThrow(InvalidWagerTransactionTransitionError);
    expect(() =>
      value.markProcessed(
        Money.from({ amount: "1000000000000000000.00", currency: "BRL" }),
        new Date(completedAt),
      ),
    ).toThrow(InvalidWagerTransactionTransitionError);
    expect(() =>
      value.markProcessed(
        Money.from({ amount: "1.00", currency: "BRL" }).negate(),
        new Date(completedAt),
      ),
    ).toThrow(InvalidWagerTransactionTransitionError);
    expect(snapshot(value)).toEqual(before);
  });

  test("retains the resulting balance as immutable terminal state", () => {
    const value = transaction();
    const resultingBalance = Money.from({ amount: "75.25", currency: "BRL" });
    value.markProcessed(resultingBalance, new Date(completedAt));
    expect(value.resultingBalance).toBe(resultingBalance);
    expect(value.resultingBalance?.toJSON()).toEqual({
      amount: "75.25",
      currency: "BRL",
    });
    expect(() =>
      value.markProcessed(Money.zero("BRL"), new Date(completedAt)),
    ).toThrow(InvalidWagerTransactionTransitionError);
    expect(value.resultingBalance).toBe(resultingBalance);
  });

  test.each([false, true])("marks REJECTED from waiting=%s", (waiting) => {
    const value = transaction(waiting);
    value.reject(
      WagerTransactionRejectionCode.REFERENCE_NOT_FOUND,
      new Date(completedAt),
    );
    expect(value.status).toBe(WagerTransactionStatus.REJECTED);
    expect(value.failureCode).toBe(
      WagerTransactionRejectionCode.REFERENCE_NOT_FOUND,
    );
    expect(value.processedAt).toEqual(new Date(completedAt));
    expect(value.updatedAt).toEqual(new Date(completedAt));
    expect(value.resultingBalance).toBeNull();
  });

  test.each([
    false,
    true,
  ])("marks permanent technical failure from waiting=%s", (waiting) => {
    const value = transaction(waiting);
    value.fail(
      WagerTransactionFailureCode.PERMANENT_PROCESSING_ERROR,
      new Date(completedAt),
    );
    expect(value.status).toBe(WagerTransactionStatus.FAILED);
    expect(value.failureCode).toBe(
      WagerTransactionFailureCode.PERMANENT_PROCESSING_ERROR,
    );
    expect(value.processedAt).toEqual(new Date(completedAt));
    expect(value.updatedAt).toEqual(new Date(completedAt));
    expect(value.resultingBalance).toBeNull();
  });

  test.each(
    Object.values(WagerTransactionRejectionCode),
  )("accepts the stable business rejection code %s", (code) => {
    const value = transaction();
    value.reject(code, new Date(completedAt));
    expect(value.failureCode).toBe(code);
    expect(value.status).toBe(WagerTransactionStatus.REJECTED);
  });

  test("keeps business and technical failure codes separate", () => {
    const value = transaction();
    const before = snapshot(value);
    const technical = WagerTransactionFailureCode.PERMANENT_PROCESSING_ERROR;
    const business = WagerTransactionRejectionCode.INSUFFICIENT_FUNDS;
    const rejectTechnical = () => {
      // @ts-expect-error A technical failure is not a business rejection.
      value.reject(technical);
    };
    const failBusiness = () => {
      // @ts-expect-error A business rejection is not a permanent technical failure.
      value.fail(business);
    };
    expect(rejectTechnical).toThrow(InvalidWagerTransactionTransitionError);
    expect(failBusiness).toThrow(InvalidWagerTransactionTransitionError);
    expect(snapshot(value)).toEqual(before);
  });

  test.each([
    "",
    "human-readable error",
    "IDEMPOTENCY_CONFLICT",
    "UNKNOWN",
  ])("rejects arbitrary failure code %j without changing state", (failureCode) => {
    const value = transaction();
    const before = snapshot(value);
    // @ts-expect-error Invalid runtime rejection codes must fail validation.
    expect(() => value.reject(failureCode)).toThrow(
      InvalidWagerTransactionTransitionError,
    );
    // @ts-expect-error Invalid runtime technical codes must fail validation.
    expect(() => value.fail(failureCode)).toThrow(
      InvalidWagerTransactionTransitionError,
    );
    expect(snapshot(value)).toEqual(before);
  });
});

describe("WagerTransaction pending references", () => {
  test.each([
    WagerTransactionKind.REFUND,
    WagerTransactionKind.ROLLBACK,
    WagerTransactionKind.WIN,
  ])("allows %s with an external reference to wait", (kind) => {
    const value = WagerTransaction.create(
      { ...props(kind), referenceExternalTransactionId: "external-original" },
      new Date(createdAt),
    );
    value.markPendingReference(new Date(waitingAt));
    expect(value.status).toBe(WagerTransactionStatus.PENDING_REFERENCE);
    expect(value.failureCode).toBeNull();
    expect(value.processedAt).toBeNull();
    expect(value.updatedAt).toEqual(new Date(waitingAt));
    expect(value.isTerminal()).toBe(false);
  });

  test.each([
    WagerTransactionKind.BET,
    WagerTransactionKind.WIN,
    WagerTransactionKind.LOSS,
  ])("cannot wait without an external reference for %s", (kind) => {
    const value = WagerTransaction.create(props(kind), new Date(createdAt));
    const before = snapshot(value);
    expect(() => value.markPendingReference(new Date(waitingAt))).toThrow(
      InvalidWagerTransactionTransitionError,
    );
    expect(snapshot(value)).toEqual(before);
  });

  test("does not put OPENING into reference waiting", () => {
    const value = WagerTransaction.createOpening(
      openingProps(),
      new Date(createdAt),
    );
    expect(() => value.markPendingReference(new Date(waitingAt))).toThrow(
      InvalidWagerTransactionTransitionError,
    );
    expect(value.status).toBe(WagerTransactionStatus.PENDING);
  });

  test("rejects a repeated pending reference transition without touching the timestamp", () => {
    const value = transaction(true);
    const before = snapshot(value);
    expect(() => value.markPendingReference(new Date(resolvedAt))).toThrow(
      InvalidWagerTransactionTransitionError,
    );
    expect(snapshot(value)).toEqual(before);
  });

  test("does not wait for an already resolved reference", () => {
    const value = transaction();
    value.resolveReference("original-transaction", new Date(resolvedAt));
    const before = snapshot(value);
    expect(() => value.markPendingReference(new Date(completedAt))).toThrow(
      InvalidWagerTransactionTransitionError,
    );
    expect(snapshot(value)).toEqual(before);
  });
});

describe("WagerTransaction reference resolution", () => {
  test.each([
    false,
    true,
  ])("resolves a reference while preserving status for waiting=%s", (waiting) => {
    const value = transaction(waiting);
    const before = value.status;
    value.resolveReference("original-transaction", new Date(resolvedAt));
    expect(value.referenceTransactionId).toBe("original-transaction");
    expect(value.referenceExternalTransactionId).toBe("external-original");
    expect(value.status).toBe(before);
    expect(value.failureCode).toBeNull();
    expect(value.processedAt).toBeNull();
    expect(value.updatedAt).toEqual(new Date(resolvedAt));
    value.markProcessed(
      Money.from({ amount: "40.00", currency: "BRL" }),
      new Date(completedAt),
    );
    expect(value.referenceTransactionId).toBe("original-transaction");
  });

  test("permits the same resolution again as a no-op", () => {
    const value = transaction(true);
    value.resolveReference("original-transaction", new Date(resolvedAt));
    const before = snapshot(value);
    value.resolveReference("original-transaction", new Date(completedAt));
    expect(snapshot(value)).toEqual(before);
  });

  test("rejects replacing an already resolved reference", () => {
    const value = transaction();
    value.resolveReference("original-transaction", new Date(resolvedAt));
    const before = snapshot(value);
    expect(() =>
      value.resolveReference("another-transaction", new Date(completedAt)),
    ).toThrow(InvalidWagerTransactionTransitionError);
    expect(snapshot(value)).toEqual(before);
  });

  test.each(["", " ", "\t\n"])("rejects empty resolved id %j", (id) => {
    const value = transaction();
    const before = snapshot(value);
    expect(() => value.resolveReference(id, new Date(resolvedAt))).toThrow(
      InvalidWagerTransactionTransitionError,
    );
    expect(snapshot(value)).toEqual(before);
  });

  test("rejects resolution without an external reference", () => {
    const value = WagerTransaction.create(
      props(WagerTransactionKind.WIN),
      new Date(createdAt),
    );
    const before = snapshot(value);
    expect(() =>
      value.resolveReference("original-transaction", new Date(resolvedAt)),
    ).toThrow(InvalidWagerTransactionTransitionError);
    expect(snapshot(value)).toEqual(before);
  });
});

describe("WagerTransaction terminality", () => {
  test.each([
    WagerTransactionStatus.PROCESSED,
    WagerTransactionStatus.REJECTED,
    WagerTransactionStatus.FAILED,
  ])("forbids every subsequent state change from %s including the same status", (status) => {
    const value = WagerTransaction.rehydrate({
      ...state(status),
      referenceTransactionId: "original-transaction",
    });
    const before = snapshot(value);
    expect(value.isTerminal()).toBe(true);
    for (const attempt of [
      () =>
        value.markProcessed(
          Money.from({ amount: "40.00", currency: "BRL" }),
          new Date(completedAt),
        ),
      () =>
        value.reject(
          WagerTransactionRejectionCode.REFERENCE_NOT_FOUND,
          new Date(completedAt),
        ),
      () =>
        value.fail(
          WagerTransactionFailureCode.PERMANENT_PROCESSING_ERROR,
          new Date(completedAt),
        ),
      () => value.markPendingReference(new Date(completedAt)),
      () =>
        value.resolveReference("original-transaction", new Date(completedAt)),
      () =>
        value.resolveReference("another-transaction", new Date(completedAt)),
    ]) {
      expect(attempt).toThrow(InvalidWagerTransactionTransitionError);
      expect(snapshot(value)).toEqual(before);
    }
  });
});

describe("WagerTransaction rehydration", () => {
  test.each(
    Object.values(WagerTransactionStatus),
  )("restores all persisted state in %s without replaying transitions", (status) => {
    const input = {
      ...state(status),
      referenceTransactionId: "original-transaction",
    };
    const value = WagerTransaction.rehydrate(input);
    expect(snapshot(value)).toEqual(input);
    expect(value.money).toBe(input.money);
  });

  test("restores an internal OPENING without provider metadata", () => {
    const input = {
      ...snapshot(
        WagerTransaction.createOpening(openingProps(), new Date(createdAt)),
      ),
      status: WagerTransactionStatus.PROCESSED,
      resultingBalance: Money.zero("BRL"),
      processedAt: new Date(completedAt),
      updatedAt: new Date(completedAt),
    };
    expect(snapshot(WagerTransaction.rehydrate(input))).toEqual(input);
  });

  test("requires a resulting balance when rehydrating PROCESSED", () => {
    expect(() =>
      WagerTransaction.rehydrate({
        ...state(WagerTransactionStatus.PROCESSED),
        resultingBalance: null,
      }),
    ).toThrow(InvalidWagerTransactionStateError);
  });

  test.each([
    WagerTransactionStatus.PENDING,
    WagerTransactionStatus.PENDING_REFERENCE,
    WagerTransactionStatus.REJECTED,
    WagerTransactionStatus.FAILED,
  ])("rejects resulting balance in %s", (status) => {
    expect(() =>
      WagerTransaction.rehydrate({
        ...state(status),
        resultingBalance: Money.zero("BRL"),
      }),
    ).toThrow(InvalidWagerTransactionStateError);
  });

  test.each([
    Money.zero("USD"),
    Money.from({ amount: "1.00", currency: "BRL" }).negate(),
    Money.from({ amount: "1000000000000000000.00", currency: "BRL" }),
  ])("rejects an invalid persisted resulting balance", (resultingBalance) => {
    expect(() =>
      WagerTransaction.rehydrate({
        ...state(WagerTransactionStatus.PROCESSED),
        resultingBalance,
      }),
    ).toThrow(InvalidWagerTransactionStateError);
  });

  test.each([
    "providerId",
    "externalTransactionId",
    "roundId",
    "gameId",
  ] as const)("rejects invented %s on persisted OPENING", (field) => {
    const input = snapshot(
      WagerTransaction.createOpening(openingProps(), new Date(createdAt)),
    );
    expect(() =>
      WagerTransaction.rehydrate({ ...input, [field]: "invented" }),
    ).toThrow(InvalidWagerTransactionStateError);
  });

  test.each([
    "providerId",
    "externalTransactionId",
    "roundId",
    "gameId",
  ] as const)("requires non-empty persisted provider %s", (field) => {
    expect(() =>
      WagerTransaction.rehydrate({ ...state(), [field]: null }),
    ).toThrow(InvalidWagerTransactionStateError);
  });

  test.each([
    WagerTransactionKind.REFUND,
    WagerTransactionKind.ROLLBACK,
  ])("rejects persisted %s without external reference", (kind) => {
    expect(() =>
      WagerTransaction.rehydrate({
        ...state(),
        kind,
        referenceExternalTransactionId: null,
      }),
    ).toThrow(InvalidWagerTransactionStateError);
  });

  test.each([
    WagerTransactionKind.BET,
    WagerTransactionKind.LOSS,
    WagerTransactionKind.OPENING,
  ])("rejects persisted reference on %s", (kind) => {
    const base =
      kind === WagerTransactionKind.OPENING
        ? snapshot(
            WagerTransaction.createOpening(openingProps(), new Date(createdAt)),
          )
        : { ...state(), kind };
    expect(() =>
      WagerTransaction.rehydrate({
        ...base,
        referenceExternalTransactionId: "external-original",
      }),
    ).toThrow(InvalidWagerTransactionStateError);
  });

  test("rejects a resolved internal reference without an external reference", () => {
    const input = {
      ...state(),
      kind: WagerTransactionKind.WIN,
      referenceExternalTransactionId: null,
      referenceTransactionId: "original-transaction",
    };
    expect(() => WagerTransaction.rehydrate(input)).toThrow(
      InvalidWagerTransactionStateError,
    );
  });

  test("rejects an empty resolved internal reference", () => {
    expect(() =>
      WagerTransaction.rehydrate({ ...state(), referenceTransactionId: " " }),
    ).toThrow(InvalidWagerTransactionStateError);
  });

  test("rejects PENDING_REFERENCE without an external reference", () => {
    expect(() =>
      WagerTransaction.rehydrate({
        ...state(WagerTransactionStatus.PENDING_REFERENCE),
        kind: WagerTransactionKind.WIN,
        referenceExternalTransactionId: null,
      }),
    ).toThrow(InvalidWagerTransactionStateError);
  });

  test.each([
    WagerTransactionStatus.PENDING,
    WagerTransactionStatus.PENDING_REFERENCE,
  ])("rejects a completion timestamp or failure code in %s", (status) => {
    expect(() =>
      WagerTransaction.rehydrate({
        ...state(status),
        processedAt: new Date(completedAt),
      }),
    ).toThrow(InvalidWagerTransactionStateError);
    expect(() =>
      WagerTransaction.rehydrate({
        ...state(status),
        failureCode: WagerTransactionRejectionCode.REFERENCE_NOT_FOUND,
      }),
    ).toThrow(InvalidWagerTransactionStateError);
  });

  test("rejects a failure code in PROCESSED", () => {
    expect(() =>
      WagerTransaction.rehydrate({
        ...state(WagerTransactionStatus.PROCESSED),
        failureCode: WagerTransactionRejectionCode.INSUFFICIENT_FUNDS,
      }),
    ).toThrow(InvalidWagerTransactionStateError);
  });

  test.each([
    WagerTransactionStatus.REJECTED,
    WagerTransactionStatus.FAILED,
  ])("requires a failure code in %s", (status) => {
    expect(() =>
      WagerTransaction.rehydrate({ ...state(status), failureCode: null }),
    ).toThrow(InvalidWagerTransactionStateError);
  });

  test.each([
    WagerTransactionStatus.PROCESSED,
    WagerTransactionStatus.REJECTED,
    WagerTransactionStatus.FAILED,
  ])("requires processedAt for terminal %s", (status) => {
    expect(() =>
      WagerTransaction.rehydrate({ ...state(status), processedAt: null }),
    ).toThrow(InvalidWagerTransactionStateError);
    expect(() =>
      WagerTransaction.rehydrate({
        ...state(status),
        processedAt: new Date("invalid"),
      }),
    ).toThrow(InvalidWagerTransactionStateError);
  });

  test("rejects business codes in FAILED and technical codes in REJECTED", () => {
    expect(() =>
      WagerTransaction.rehydrate({
        ...state(WagerTransactionStatus.FAILED),
        failureCode: WagerTransactionRejectionCode.INSUFFICIENT_FUNDS,
      }),
    ).toThrow(InvalidWagerTransactionStateError);
    expect(() =>
      WagerTransaction.rehydrate({
        ...state(WagerTransactionStatus.REJECTED),
        failureCode: WagerTransactionFailureCode.PERMANENT_PROCESSING_ERROR,
      }),
    ).toThrow(InvalidWagerTransactionStateError);
  });

  test("rejects unknown persisted kind, status and failure codes", () => {
    const kind = { ...state(), kind: "UNKNOWN" };
    const status = { ...state(), status: "UNKNOWN" };
    const failureCode = {
      ...state(WagerTransactionStatus.REJECTED),
      failureCode: "UNKNOWN",
    };
    // @ts-expect-error Persisted data may contain an unsupported transaction kind.
    expect(() => WagerTransaction.rehydrate(kind)).toThrow(
      InvalidWagerTransactionStateError,
    );
    // @ts-expect-error Persisted data may contain an unsupported status.
    expect(() => WagerTransaction.rehydrate(status)).toThrow(
      InvalidWagerTransactionStateError,
    );
    // @ts-expect-error Persisted data may contain an unsupported failure code.
    expect(() => WagerTransaction.rehydrate(failureCode)).toThrow(
      InvalidWagerTransactionStateError,
    );
  });
});

describe("WagerTransaction timestamps and encapsulation", () => {
  test("rejects invalid creation dates in both factories", () => {
    expect(() => WagerTransaction.create(props(), new Date("invalid"))).toThrow(
      InvalidWagerTransactionStateError,
    );
    expect(() =>
      WagerTransaction.createOpening(openingProps(), new Date("invalid")),
    ).toThrow(InvalidWagerTransactionStateError);
  });

  test.each([
    "createdAt",
    "updatedAt",
  ] as const)("rejects invalid persisted %s", (field) => {
    expect(() =>
      WagerTransaction.rehydrate({ ...state(), [field]: new Date("invalid") }),
    ).toThrow(InvalidWagerTransactionStateError);
  });

  test("rejects updatedAt before createdAt", () => {
    expect(() =>
      WagerTransaction.rehydrate({
        ...state(),
        updatedAt: new Date("2025-12-31T00:00:00.000Z"),
      }),
    ).toThrow(InvalidWagerTransactionStateError);
  });

  test.each([
    createdAt,
    "2026-01-01T10:04:00.000Z",
  ])("rejects a terminal completion timestamp differing from updatedAt: %s", (at) => {
    expect(() =>
      WagerTransaction.rehydrate({
        ...state(WagerTransactionStatus.PROCESSED),
        processedAt: new Date(at),
      }),
    ).toThrow(InvalidWagerTransactionStateError);
  });

  test.each([
    "processed",
    "rejected",
    "failed",
    "waiting",
    "resolved",
  ] as const)("rejects invalid or backward timestamps for %s without changing state", (operation) => {
    const value = transaction();
    value.resolveReference("original-transaction", new Date(resolvedAt));
    for (const at of [new Date("invalid"), new Date(waitingAt)]) {
      const before = snapshot(value);
      const attempt = () => {
        switch (operation) {
          case "processed":
            return value.markProcessed(
              Money.from({ amount: "40.00", currency: "BRL" }),
              at,
            );
          case "rejected":
            return value.reject(
              WagerTransactionRejectionCode.REFERENCE_NOT_FOUND,
              at,
            );
          case "failed":
            return value.fail(
              WagerTransactionFailureCode.PERMANENT_PROCESSING_ERROR,
              at,
            );
          case "waiting":
            return value.markPendingReference(at);
          case "resolved":
            return value.resolveReference("original-transaction", at);
        }
      };
      expect(attempt).toThrow(InvalidWagerTransactionTransitionError);
      expect(snapshot(value)).toEqual(before);
    }
  });

  test("validates pending reference transition time before mutating", () => {
    for (const at of [
      new Date("invalid"),
      new Date("2025-12-31T00:00:00.000Z"),
    ]) {
      const value = transaction();
      const before = snapshot(value);
      expect(() => value.markPendingReference(at)).toThrow(
        InvalidWagerTransactionTransitionError,
      );
      expect(snapshot(value)).toEqual(before);
    }
  });

  test("allows transitions within the same timestamp", () => {
    const value = transaction();
    value.markPendingReference(new Date(createdAt));
    value.resolveReference("original-transaction", new Date(createdAt));
    value.markProcessed(
      Money.from({ amount: "40.00", currency: "BRL" }),
      new Date(createdAt),
    );
    expect(value.processedAt).toEqual(new Date(createdAt));
  });

  test("uses current time when transition timestamps are omitted", () => {
    const processed = transaction();
    processed.markProcessed(Money.from({ amount: "40.00", currency: "BRL" }));
    const rejected = transaction();
    rejected.reject(WagerTransactionRejectionCode.REFERENCE_NOT_FOUND);
    const failed = transaction();
    failed.fail(WagerTransactionFailureCode.PERMANENT_PROCESSING_ERROR);
    const waiting = transaction();
    waiting.markPendingReference();
    waiting.resolveReference("original-transaction");
    for (const value of [processed, rejected, failed, waiting]) {
      expect(value.updatedAt.getTime()).toBeGreaterThan(
        new Date(createdAt).getTime(),
      );
    }
  });

  test("copies creation, resolution and completion dates on input and output", () => {
    const at = new Date(createdAt);
    const value = WagerTransaction.create(
      props(WagerTransactionKind.REFUND),
      at,
    );
    at.setUTCFullYear(2000);
    value.createdAt.setUTCFullYear(2000);
    value.updatedAt.setUTCFullYear(2000);
    expect(value.createdAt).toEqual(new Date(createdAt));
    expect(value.updatedAt).toEqual(new Date(createdAt));
    const resolved = new Date(resolvedAt);
    value.resolveReference("original-transaction", resolved);
    resolved.setUTCFullYear(2000);
    value.updatedAt.setUTCFullYear(2000);
    expect(value.updatedAt).toEqual(new Date(resolvedAt));
    const completed = new Date(completedAt);
    value.markProcessed(
      Money.from({ amount: "40.00", currency: "BRL" }),
      completed,
    );
    completed.setUTCFullYear(2000);
    value.processedAt?.setUTCFullYear(2000);
    value.updatedAt.setUTCFullYear(2000);
    expect(value.processedAt).toEqual(new Date(completedAt));
    expect(value.updatedAt).toEqual(new Date(completedAt));
  });

  test("copies persisted Date values and does not retain mutable state properties", () => {
    const input = state(WagerTransactionStatus.PROCESSED);
    const value = WagerTransaction.rehydrate(input);
    const before = snapshot(value);
    input.id = "another-transaction";
    input.payloadHash = "changed";
    input.money = Money.zero("USD");
    input.status = WagerTransactionStatus.PENDING;
    input.createdAt.setUTCFullYear(2000);
    input.updatedAt.setUTCFullYear(2000);
    input.processedAt?.setUTCFullYear(2000);
    value.createdAt.setUTCFullYear(2000);
    value.updatedAt.setUTCFullYear(2000);
    value.processedAt?.setUTCFullYear(2000);
    expect(snapshot(value)).toEqual(before);
  });

  test("prevents arbitrary writes to fixed data and controlled state", () => {
    const value = transaction();
    const before = snapshot(value);
    expect(Object.isFrozen(value)).toBe(true);
    for (const field of Object.keys(before)) {
      expect(Reflect.set(value, field, "changed")).toBe(false);
      expect(() =>
        Object.defineProperty(value, field, { value: "changed" }),
      ).toThrow(TypeError);
    }
    expect(Reflect.deleteProperty(value, "money")).toBe(false);
    expect(snapshot(value)).toEqual(before);
  });
});
