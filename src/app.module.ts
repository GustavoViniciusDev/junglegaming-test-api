import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { HealthModule } from "./health/health.module";
import { ConfigModule } from "./infrastructure/config/config.module";
import { LoggingModule } from "./infrastructure/logging/logging.module";
import { MetricsModule } from "./infrastructure/metrics/metrics.module";
import { WalletModule } from "./wallet/wallet.module";
import { WageringModule } from "./wagering/wagering.module";
import { AuthenticationExtensionGuard } from "./infrastructure/authentication/authentication-extension.guard";

@Module({
  imports: [
    ConfigModule,
    LoggingModule,
    MetricsModule,
    HealthModule,
    WalletModule,
    WageringModule,
  ],
  providers: [
    {
      provide: APP_GUARD,
      useClass: AuthenticationExtensionGuard,
    },
  ],
})
export class AppModule {}
