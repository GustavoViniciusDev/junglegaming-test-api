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

interface HttpResponse {
  status(code: number): HttpResponse;
}

@Controller("wagering/transactions")
@UseFilters(WageringHttpExceptionFilter)
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
