import {
  Controller,
  Inject,
  Optional,
  Param,
  Post,
  UseFilters,
} from "@nestjs/common";
import { PinoLogger } from "nestjs-pino";
import { WageringMetrics } from "../infrastructure/metrics/wagering-metrics";
import { ReadHttpExceptionFilter } from "../shared/http/read-http-exception.filter";
import { ReconcileWallet } from "./application/reconcile-wallet";

@Controller("wallets")
@UseFilters(ReadHttpExceptionFilter)
export class WalletReconciliationController {
  constructor(
    @Inject(ReconcileWallet) private readonly reconcileWallet: ReconcileWallet,
    @Inject(PinoLogger) private readonly logger: PinoLogger,
    @Optional()
    @Inject(WageringMetrics)
    private readonly metrics?: WageringMetrics,
  ) {}

  @Post(":walletId/reconciliation")
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
