import { Controller, Get, Inject, Param, UseFilters } from "@nestjs/common";
import { ReadWagerTransaction } from "./application/read-wager-transaction";
import { ReadHttpExceptionFilter } from "../shared/http/read-http-exception.filter";
import type { WagerTransaction } from "./domain/wager-transaction";

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
export class WagerTransactionReadsController {
  constructor(
    @Inject(ReadWagerTransaction)
    private readonly reader: ReadWagerTransaction,
  ) {}

  @Get(":transactionId")
  async byId(@Param("transactionId") transactionId: string) {
    return toResponse(await this.reader.byId(transactionId));
  }
}

@Controller("providers/:providerId/wagering/transactions")
@UseFilters(ReadHttpExceptionFilter)
export class ProviderWagerTransactionReadsController {
  constructor(
    @Inject(ReadWagerTransaction)
    private readonly reader: ReadWagerTransaction,
  ) {}

  @Get(":externalTransactionId")
  async byProviderIdentity(
    @Param("providerId") providerId: string,
    @Param("externalTransactionId") externalTransactionId: string,
  ) {
    return toResponse(
      await this.reader.byProviderIdentity(providerId, externalTransactionId),
    );
  }
}
