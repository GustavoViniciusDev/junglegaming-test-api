import {
  Controller,
  Inject,
  Optional,
  Param,
  Post,
  UseFilters,
} from "@nestjs/common";
import {
  ApiExtraModels,
  ApiNotFoundResponse,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiServiceUnavailableResponse,
  ApiTags,
} from "@nestjs/swagger";
import { PinoLogger } from "nestjs-pino";
import { WageringMetrics } from "../infrastructure/metrics/wagering-metrics";
import { ReadHttpExceptionFilter } from "../shared/http/read-http-exception.filter";
import { ReconcileWallet } from "./application/reconcile-wallet";
import {
  ApiErrorSchema,
  WalletReconciliationSchema,
} from "../shared/http/openapi-schemas";

@Controller("wallets")
@UseFilters(ReadHttpExceptionFilter)
@ApiTags("Reconciliation")
@ApiExtraModels(ApiErrorSchema, WalletReconciliationSchema)
export class WalletReconciliationController {
  constructor(
    @Inject(ReconcileWallet) private readonly reconcileWallet: ReconcileWallet,
    @Inject(PinoLogger) private readonly logger: PinoLogger,
    @Optional()
    @Inject(WageringMetrics)
    private readonly metrics?: WageringMetrics,
  ) {}

  @Post(":walletId/reconciliation")
  @ApiOperation({
    summary: "Reconcile a wallet",
    description:
      "Compares the stored balance with the ledger reconstruction. difference = storedBalance - calculatedBalance. This operation never repairs data.",
  })
  @ApiParam({ name: "walletId", type: String })
  @ApiResponse({
    status: 201,
    description: "Reconciliation completed",
    type: WalletReconciliationSchema,
  })
  @ApiResponse({
    status: 400,
    description: "Invalid wallet ID",
    type: ApiErrorSchema,
  })
  @ApiNotFoundResponse({
    description: "Wallet not found",
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
  async reconcile(@Param("walletId") walletId: string) {
    const result = await this.reconcileWallet.execute(walletId);
    if (!result.consistent) {
      this.metrics?.recordReconciliationMismatch();
      this.logger.warn(
        {
          walletId: result.walletId,
          storedBalance: result.storedBalance,
          calculatedBalance: result.calculatedBalance,
          difference: result.difference,
          checkedEntries: result.checkedEntries,
        },
        "Wallet ledger reconciliation mismatch",
      );
    }
    return {
      storedBalance: result.storedBalance,
      calculatedBalance: result.calculatedBalance,
      difference: result.difference,
      consistent: result.consistent,
      checkedEntries: result.checkedEntries,
    };
  }
}
