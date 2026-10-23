import {
  Body,
  Controller,
  Headers,
  Inject,
  HttpStatus,
  Post,
  Optional,
  Req,
  Res,
  UseFilters,
} from "@nestjs/common";
import {
  ApiAcceptedResponse,
  ApiBadRequestResponse,
  ApiBody,
  ApiConflictResponse,
  ApiExtraModels,
  ApiHeader,
  ApiNotFoundResponse,
  ApiOperation,
  ApiResponse,
  ApiServiceUnavailableResponse,
  ApiTags,
} from "@nestjs/swagger";
import { performance } from "node:perf_hooks";
import { PinoLogger } from "nestjs-pino";
import { WageringMetrics } from "../infrastructure/metrics/wagering-metrics";
import type { TransactionMetricOutcome } from "../shared/application/observability";
import {
  IdempotencyConflictError,
  InvalidWagerProcessingRequestError,
  ProcessWagerTransaction,
  ProviderTransactionConflictError,
} from "./application/process-wager-transaction";
import { WagerTransactionStatus } from "./domain/wager-transaction-status";
import { wagerTransactionDataSchema } from "./contracts/wager-transaction-data.schema";
import { WagerTransactionKind } from "./domain/wager-transaction-kind";
import { WageringHttpExceptionFilter } from "./http/wagering-http-exception.filter";
import {
  ApiErrorSchema,
  WagerTransactionRequestSchema,
  WagerTransactionResultSchema,
} from "../shared/http/openapi-schemas";

interface HttpResponse {
  status(code: number): HttpResponse;
}

@Controller("wagering/transactions")
@UseFilters(WageringHttpExceptionFilter)
@ApiTags("Wagering")
@ApiExtraModels(
  ApiErrorSchema,
  WagerTransactionRequestSchema,
  WagerTransactionResultSchema,
)
export class WageringTransactionsController {
  constructor(
    @Inject(ProcessWagerTransaction)
    private readonly processor: ProcessWagerTransaction,
    @Optional()
    @Inject(WageringMetrics)
    private readonly metrics?: WageringMetrics,
    @Optional()
    @Inject(PinoLogger)
    private readonly logger?: PinoLogger,
  ) {}

  @Post()
  @ApiOperation({
    summary: "Process a wagering transaction",
    description:
      "Persistent idempotency key. Reusing the same key with the same business payload returns the original result. Reusing it with a different business payload results in a conflict. The persistent provider identity (providerId + externalTransactionId) also converges identical payloads to the original operation and conflicts on divergent payloads. OPENING is internal and is not accepted.",
  })
  @ApiHeader({
    name: "idempotency-key",
    required: true,
    description:
      "Persistent idempotency key. Same key and same business payload replays the original result; same key and different business payload returns 409.",
    example: "demo-bet-001",
  })
  @ApiResponse({
    status: 201,
    description:
      "New transaction processed. Example: PROCESSED, failureCode null, resultingBalance { amount: '80.00', currency: 'BRL' }, idempotentReplay false.",
    type: WagerTransactionResultSchema,
  })
  @ApiResponse({
    status: 200,
    description:
      "Idempotent replay. Returns the original transaction result and resulting-balance snapshot with idempotentReplay true.",
    type: WagerTransactionResultSchema,
  })
  @ApiAcceptedResponse({
    description:
      "Reference has not arrived yet. Example: PENDING_REFERENCE, failureCode null, resultingBalance null.",
    type: WagerTransactionResultSchema,
  })
  @ApiResponse({
    status: 422,
    description:
      "Business rejection, including insufficient funds, wallet/player/currency mismatch or reference rejection. Example failure codes include INSUFFICIENT_FUNDS, REFERENCE_NOT_FOUND and REVERSAL_WOULD_CAUSE_NEGATIVE_BALANCE.",
    type: WagerTransactionResultSchema,
  })
  @ApiBadRequestResponse({
    description:
      "Invalid body, missing Idempotency-Key, invalid Money, unsupported kind or invalid reference shape",
    type: ApiErrorSchema,
  })
  @ApiNotFoundResponse({
    description: "Wallet not found",
    type: ApiErrorSchema,
  })
  @ApiConflictResponse({
    description:
      "Idempotency key or provider transaction identity reused with a divergent business payload",
    type: ApiErrorSchema,
  })
  @ApiServiceUnavailableResponse({
    description: "Recognized transient infrastructure failure",
    type: ApiErrorSchema,
  })
  @ApiResponse({
    status: 500,
    description: "Unexpected server error; internal details are not returned",
    type: ApiErrorSchema,
  })
  @ApiBody({
    type: WagerTransactionRequestSchema,
    examples: {
      bet: {
        summary: "BET",
        value: {
          providerId: "provider-demo",
          externalTransactionId: "bet-001",
          playerId: "player-demo",
          walletId: "wallet-demo",
          roundId: "round-001",
          gameId: "game-demo",
          kind: "BET",
          money: { amount: "20.00", currency: "BRL" },
        },
      },
      win: {
        summary: "WIN with optional BET reference",
        value: {
          providerId: "provider-demo",
          externalTransactionId: "win-001",
          playerId: "player-demo",
          walletId: "wallet-demo",
          roundId: "round-001",
          gameId: "game-demo",
          kind: "WIN",
          money: { amount: "25.00", currency: "BRL" },
          referenceExternalTransactionId: "bet-001",
        },
      },
      loss: {
        summary: "LOSS",
        value: {
          providerId: "provider-demo",
          externalTransactionId: "loss-001",
          playerId: "player-demo",
          walletId: "wallet-demo",
          roundId: "round-001",
          gameId: "game-demo",
          kind: "LOSS",
          money: { amount: "20.00", currency: "BRL" },
        },
      },
      refund: {
        summary: "REFUND of a processed BET",
        value: {
          providerId: "provider-demo",
          externalTransactionId: "refund-001",
          playerId: "player-demo",
          walletId: "wallet-demo",
          roundId: "round-001",
          gameId: "game-demo",
          kind: "REFUND",
          money: { amount: "20.00", currency: "BRL" },
          referenceExternalTransactionId: "bet-001",
        },
      },
      rollback: {
        summary: "ROLLBACK of a processed operation",
        value: {
          providerId: "provider-demo",
          externalTransactionId: "rollback-001",
          playerId: "player-demo",
          walletId: "wallet-demo",
          roundId: "round-001",
          gameId: "game-demo",
          kind: "ROLLBACK",
          money: { amount: "20.00", currency: "BRL" },
          referenceExternalTransactionId: "bet-001",
        },
      },
    },
  })
  async process(
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: HttpResponse,
    @Req() request: { id?: string },
  ) {
    const startedAt = performance.now();
    let outcome: TransactionMetricOutcome = "error";
    let result:
      | Awaited<ReturnType<ProcessWagerTransaction["execute"]>>
      | undefined;
    let providerId: string | undefined;
    if (idempotencyKey === undefined || idempotencyKey.trim().length === 0) {
      throw new InvalidWagerProcessingRequestError(
        "Idempotency-Key header is required",
      );
    }
    const parsed = wagerTransactionDataSchema.safeParse(body);
    if (!parsed.success) {
      throw new InvalidWagerProcessingRequestError(
        "Wager transaction request payload is invalid",
      );
    }
    providerId = parsed.data.providerId;
    const { referenceExternalTransactionId, ...businessFields } = parsed.data;
    try {
      result = await this.processor.execute({
        ...businessFields,
        kind: WagerTransactionKind[businessFields.kind],
        ...(referenceExternalTransactionId === undefined
          ? {}
          : { referenceExternalTransactionId }),
        idempotencyKey,
      });
      outcome = result.idempotentReplay
        ? "replay"
        : result.status === WagerTransactionStatus.PROCESSED
          ? "processed"
          : result.status === WagerTransactionStatus.REJECTED
            ? "rejected"
            : "pending_reference";
      response.status(this.statusFor(result.status, result.idempotentReplay));
      const context = {
        correlationId: request.id,
        transactionId: result.transactionId,
        walletId: result.walletId,
        providerId,
        status: result.status,
        replay: result.idempotentReplay,
      };
      if (result.status === WagerTransactionStatus.REJECTED) {
        this.logger?.warn(
          context,
          "Wager transaction rejected by business rules",
        );
      } else {
        this.logger?.info(context, "Wager transaction request completed");
      }
      return result;
    } catch (error) {
      outcome =
        error instanceof IdempotencyConflictError ||
        error instanceof ProviderTransactionConflictError
          ? "conflict"
          : "error";
      throw error;
    } finally {
      this.metrics?.observeProcessing(
        "http",
        outcome,
        (performance.now() - startedAt) / 1000,
      );
    }
  }

  private statusFor(
    status: WagerTransactionStatus,
    idempotentReplay: boolean,
  ): number {
    if (idempotentReplay) return HttpStatus.OK;
    if (status === WagerTransactionStatus.PROCESSED) return HttpStatus.CREATED;
    if (status === WagerTransactionStatus.PENDING_REFERENCE) {
      return HttpStatus.ACCEPTED;
    }
    return HttpStatus.UNPROCESSABLE_ENTITY;
  }
}
