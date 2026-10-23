import { Module } from "@nestjs/common";
import { DatabaseModule } from "../infrastructure/database/database.module";
import { LoggingModule } from "../infrastructure/logging/logging.module";
import { CreateWallet } from "./application/create-wallet";
import { MikroOrmWalletCreationStore } from "./infrastructure/mikro-orm-wallet-creation-store";
import { WalletsController } from "./wallets.controller";
import { MikroOrmWalletReadStore } from "./infrastructure/mikro-orm-wallet-read-store";
import { ReadWallet, ReadWalletLedger } from "./application/read-wallet";
import { ReconcileWallet } from "./application/reconcile-wallet";
import { MikroOrmWalletReconciliationStore } from "./infrastructure/mikro-orm-wallet-reconciliation-store";
import { WalletReconciliationController } from "./wallet-reconciliation.controller";
import { MetricsModule } from "../infrastructure/metrics/metrics.module";

@Module({
  imports: [DatabaseModule, LoggingModule, MetricsModule],
  controllers: [WalletsController, WalletReconciliationController],
  providers: [
    MikroOrmWalletCreationStore,
    MikroOrmWalletReadStore,
    MikroOrmWalletReconciliationStore,
    {
      provide: CreateWallet,
      inject: [MikroOrmWalletCreationStore],
      useFactory: (store: MikroOrmWalletCreationStore) =>
        new CreateWallet(store),
    },
    {
      provide: ReadWallet,
      inject: [MikroOrmWalletReadStore],
      useFactory: (store: MikroOrmWalletReadStore) => new ReadWallet(store),
    },
    {
      provide: ReadWalletLedger,
      inject: [MikroOrmWalletReadStore],
      useFactory: (store: MikroOrmWalletReadStore) =>
        new ReadWalletLedger(store),
    },
    {
      provide: ReconcileWallet,
      inject: [MikroOrmWalletReconciliationStore],
      useFactory: (store: MikroOrmWalletReconciliationStore) =>
        new ReconcileWallet(store),
    },
  ],
})
export class WalletModule {}
