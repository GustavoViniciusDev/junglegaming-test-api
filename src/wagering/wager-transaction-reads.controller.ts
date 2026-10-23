import { Controller, Get, Inject, Param, UseFilters } from "@nestjs/common";
import {
  ApiExtraModels,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiServiceUnavailableResponse,
  ApiTags,
} from "@nestjs/swagger";
import { ReadWagerTransaction } from "./application/read-wager-transaction";
import { ReadHttpExceptionFilter } from "../shared/http/read-http-exception.filter";
import type { WagerTransaction } from "./domain/wager-transaction";
import {
  ApiErrorSchema,
  WagerTransactionReadSchema,
} from "../shared/http/openapi-schemas";

function toResponse(transaction: WagerTransaction) {
  return {
    id: transaction.id,
    providerId: transaction.providerId,
    externalTransactionId: transaction.externalTransactionId,
    walletId: transaction.walletId,
    playerId: transaction.playerId,
    roundId: transaction.roundId,
    gameId: transaction.gameId,
    kind: transaction.kind,
    status: transaction.status,
    money: transaction.money.toJSON(),
    referenceExternalTransactionId: transaction.referenceExternalTransactionId,
    referenceTransactionId: transaction.referenceTransactionId,
    failureCode: transaction.failureCode,
    resultingBalance: transaction.resultingBalance?.toJSON() ?? null,
    processedAt: transaction.processedAt?.toISOString() ?? null,
    createdAt: transaction.createdAt.toISOString(),
    updatedAt: transaction.updatedAt.toISOString(),
  };
}

@Controller("wagering/transactions")
@UseFilters(ReadHttpExceptionFilter)
@ApiTags("Wagering")
@ApiExtraModels(ApiErrorSchema, WagerTransactionReadSchema)
export class WagerTransactionReadsController {
  constructor(
    @Inject(ReadWagerTransaction)
    private readonly reader: ReadWagerTransaction,
  ) {}

  @Get(":transactionId")
  @ApiOperation({ summary: "Get a wagering transaction by internal ID" })
  @ApiParam({ name: "transactionId", type: String })
  @ApiOkResponse({
    description: "Transaction found",
    type: WagerTransactionReadSchema,
  })
  @ApiNotFoundResponse({
    description: "Transaction not found",
    type: ApiErrorSchema,
  })
  @ApiResponse({
    status: 400,
    description: "Invalid transaction ID",
    type: ApiErrorSchema,
  })
  @ApiServiceUnavailableResponse({
    description: "A required dependency is temporarily unavailable",
    type: ApiErrorSchema,
  })
  @ApiResponse({
    status: 500,
    description: "Unexpected server error",
    type: ApiErrorSchema,
  })
  async byId(@Param("transactionId") transactionId: string) {
    return toResponse(await this.reader.byId(transactionId));
  }
}

@Controller("providers/:providerId/wagering/transactions")
@UseFilters(ReadHttpExceptionFilter)
@ApiTags("Wagering")
@ApiExtraModels(ApiErrorSchema, WagerTransactionReadSchema)
export class ProviderWagerTransactionReadsController {
  constructor(
    @Inject(ReadWagerTransaction)
    private readonly reader: ReadWagerTransaction,
  ) {}

  @Get(":externalTransactionId")
  @ApiOperation({
    summary: "Get a wagering transaction by provider identity",
    description:
      "Resolves by the composite providerId + externalTransactionId identity.",
  })
  @ApiParam({ name: "providerId", type: String })
  @ApiParam({ name: "externalTransactionId", type: String })
  @ApiOkResponse({
    description: "Transaction found",
    type: WagerTransactionReadSchema,
  })
  @ApiNotFoundResponse({
    description: "Transaction not found for this provider identity",
    type: ApiErrorSchema,
  })
  @ApiResponse({
    status: 400,
    description: "Invalid identity parameter",
    type: ApiErrorSchema,
  })
  @ApiServiceUnavailableResponse({
    description: "A required dependency is temporarily unavailable",
    type: ApiErrorSchema,
  })
  @ApiResponse({
    status: 500,
    description: "Unexpected server error",
    type: ApiErrorSchema,
  })
  async byProviderIdentity(
    @Param("providerId") providerId: string,
    @Param("externalTransactionId") externalTransactionId: string,
  ) {
    return toResponse(
      await this.reader.byProviderIdentity(providerId, externalTransactionId),
    );
  }
}
