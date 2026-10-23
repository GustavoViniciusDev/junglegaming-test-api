import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  WagerTransactionFailureCode,
  WagerTransactionRejectionCode,
} from "../../wagering/domain/wager-transaction-failure-code";
import { WagerTransactionStatus } from "../../wagering/domain/wager-transaction-status";

const rejectionCodes = Object.values(WagerTransactionRejectionCode);
const failureCodes = Object.values(WagerTransactionFailureCode);

export class MoneySchema {
  @ApiProperty({
    type: String,
    pattern: "^[0-9]+\\.[0-9]{2}$",
    example: "100.00",
    description: "Decimal monetary amount represented as a fixed-point string.",
  })
  amount!: string;

  @ApiProperty({
    type: String,
    pattern: "^[A-Z]{3}$",
    example: "BRL",
    description:
      "Three-letter uppercase currency identifier used by the wallet.",
  })
  currency!: string;
}

export class SignedMoneySchema {
  @ApiProperty({
    type: String,
    pattern: "^-?[0-9]+\\.[0-9]{2}$",
    example: "-5.00",
    description:
      "Signed decimal difference represented as a fixed-point string.",
  })
  amount!: string;

  @ApiProperty({ type: String, example: "BRL" })
  currency!: string;
}

export class WalletCreateRequestSchema {
  @ApiProperty({ type: String, example: "player-demo" })
  playerId!: string;

  @ApiProperty({ type: String, example: "BRL", pattern: "^[A-Z]{3}$" })
  currency!: string;

  @ApiProperty({
    type: String,
    example: "100.00",
    pattern: "^[0-9]+\\.[0-9]{2}$",
    description:
      "Initial balance as a decimal string; JSON numbers are not accepted.",
  })
  initialBalance!: string;
}

export class WalletCreateResponseSchema {
  @ApiProperty({
    type: String,
    example: "b95db020-2e1f-4a31-a0bd-1b0bfc813145",
  })
  walletId!: string;

  @ApiProperty({ type: String, example: "player-demo" })
  playerId!: string;

  @ApiProperty({ type: String, example: "BRL" })
  currency!: string;

  @ApiProperty({
    type: String,
    example: "100.00",
    pattern: "^[0-9]+\\.[0-9]{2}$",
  })
  balance!: string;

  @ApiProperty({ type: Number, example: 1, minimum: 1 })
  version!: number;
}

export class WalletResponseSchema {
  @ApiProperty({
    type: String,
    example: "b95db020-2e1f-4a31-a0bd-1b0bfc813145",
  })
  id!: string;

  @ApiProperty({ type: String, example: "player-demo" })
  playerId!: string;

  @ApiProperty({ type: String, example: "BRL" })
  currency!: string;

  @ApiProperty({ type: () => MoneySchema })
  balance!: MoneySchema;

  @ApiProperty({ type: Number, example: 2, minimum: 1 })
  version!: number;

  @ApiProperty({ type: String, format: "date-time" })
  createdAt!: string;

  @ApiProperty({ type: String, format: "date-time" })
  updatedAt!: string;
}

export class WalletLedgerEntrySchema {
  @ApiProperty({ type: String })
  id!: string;

  @ApiProperty({ type: String })
  walletId!: string;

  @ApiProperty({ type: String })
  transactionId!: string;

  @ApiProperty({ type: String, enum: ["CREDIT", "DEBIT"] })
  direction!: string;

  @ApiProperty({ type: () => MoneySchema })
  money!: MoneySchema;

  @ApiProperty({ type: () => MoneySchema })
  balanceBefore!: MoneySchema;

  @ApiProperty({ type: () => MoneySchema })
  balanceAfter!: MoneySchema;

  @ApiProperty({ type: String, format: "date-time" })
  createdAt!: string;
}

export class WalletLedgerPageSchema {
  @ApiProperty({ type: () => [WalletLedgerEntrySchema] })
  items!: WalletLedgerEntrySchema[];

  @ApiProperty({
    type: String,
    nullable: true,
    example: null,
    description: "Opaque cursor for the next page.",
  })
  nextCursor!: string | null;
}

export class WalletReconciliationSchema {
  @ApiProperty({ type: () => MoneySchema })
  storedBalance!: MoneySchema;

  @ApiProperty({ type: () => MoneySchema })
  calculatedBalance!: MoneySchema;

  @ApiProperty({
    type: () => SignedMoneySchema,
    description: "storedBalance minus calculatedBalance.",
  })
  difference!: SignedMoneySchema;

  @ApiProperty({ type: Boolean, example: true })
  consistent!: boolean;

  @ApiProperty({ type: Number, example: 3, minimum: 0 })
  checkedEntries!: number;
}

export class WagerTransactionRequestSchema {
  @ApiProperty({ type: String, example: "provider-demo" })
  providerId!: string;

  @ApiProperty({ type: String, example: "bet-001" })
  externalTransactionId!: string;

  @ApiProperty({ type: String, example: "player-demo" })
  playerId!: string;

  @ApiProperty({
    type: String,
    example: "b95db020-2e1f-4a31-a0bd-1b0bfc813145",
  })
  walletId!: string;

  @ApiProperty({ type: String, example: "round-001" })
  roundId!: string;

  @ApiProperty({ type: String, example: "game-demo" })
  gameId!: string;

  @ApiProperty({
    type: String,
    enum: ["BET", "WIN", "LOSS", "REFUND", "ROLLBACK"],
    example: "BET",
  })
  kind!: string;

  @ApiProperty({ type: () => MoneySchema })
  money!: MoneySchema;

  @ApiPropertyOptional({
    type: String,
    example: "bet-001",
    description:
      "Required for REFUND and ROLLBACK; optional for WIN; forbidden for BET and LOSS.",
  })
  referenceExternalTransactionId?: string;
}

export class WagerTransactionResultSchema {
  @ApiProperty({
    type: String,
    example: "9e2ca658-7842-40bc-b2d3-f166f8a0f6ae",
  })
  transactionId!: string;

  @ApiProperty({
    type: String,
    enum: ["PROCESSED", "PENDING_REFERENCE", "REJECTED"],
  })
  status!: string;

  @ApiProperty({
    type: String,
    enum: [...rejectionCodes, ...failureCodes],
    nullable: true,
    example: null,
  })
  failureCode!: string | null;

  @ApiProperty({
    type: String,
    example: "b95db020-2e1f-4a31-a0bd-1b0bfc813145",
  })
  walletId!: string;

  @ApiProperty({ type: () => MoneySchema, nullable: true })
  resultingBalance!: MoneySchema | null;

  @ApiProperty({ type: Boolean, example: false })
  idempotentReplay!: boolean;
}

export class WagerTransactionReadSchema {
  @ApiProperty({ type: String })
  id!: string;

  @ApiProperty({ type: String, nullable: true })
  providerId!: string | null;

  @ApiProperty({ type: String, nullable: true })
  externalTransactionId!: string | null;

  @ApiProperty({ type: String })
  walletId!: string;

  @ApiProperty({ type: String })
  playerId!: string;

  @ApiProperty({ type: String, nullable: true })
  roundId!: string | null;

  @ApiProperty({ type: String, nullable: true })
  gameId!: string | null;

  @ApiProperty({
    type: String,
    enum: ["OPENING", "BET", "WIN", "LOSS", "REFUND", "ROLLBACK"],
  })
  kind!: string;

  @ApiProperty({ type: String, enum: Object.values(WagerTransactionStatus) })
  status!: string;

  @ApiProperty({ type: () => MoneySchema })
  money!: MoneySchema;

  @ApiProperty({ type: String, nullable: true })
  referenceExternalTransactionId!: string | null;

  @ApiProperty({ type: String, nullable: true })
  referenceTransactionId!: string | null;

  @ApiProperty({
    type: String,
    enum: [...rejectionCodes, ...failureCodes],
    nullable: true,
  })
  failureCode!: string | null;

  @ApiProperty({ type: () => MoneySchema, nullable: true })
  resultingBalance!: MoneySchema | null;

  @ApiProperty({ type: String, format: "date-time", nullable: true })
  processedAt!: string | null;

  @ApiProperty({ type: String, format: "date-time" })
  createdAt!: string;

  @ApiProperty({ type: String, format: "date-time" })
  updatedAt!: string;
}

export class ApiErrorSchema {
  @ApiProperty({ type: Number, example: 400 })
  statusCode!: number;

  @ApiProperty({ type: String, example: "Bad Request" })
  error!: string;

  @ApiProperty({ type: String, example: "Request payload is invalid" })
  message!: string;
}

export class HealthLiveSchema {
  @ApiProperty({ type: String, example: "ok" })
  status!: string;
}

export class HealthReadySchema {
  @ApiProperty({ type: String, example: "ok" })
  status!: string;

  @ApiProperty({
    type: "object",
    additionalProperties: { type: "string", enum: ["up", "down"] },
    example: { postgres: "up", sqs: "up" },
  })
  dependencies!: { postgres: string; sqs: string };
}
