import { Module } from "@nestjs/common";
import { LoggerModule } from "nestjs-pino";
import { randomUUID } from "node:crypto";
import { ENVIRONMENT } from "../config/config.module";
import type { Environment } from "../config/environment";

export type LogContext = Partial<
  Record<
    "correlationId" | "messageId" | "transactionId" | "walletId" | "providerId",
    string
  >
>;

@Module({
  imports: [
    LoggerModule.forRootAsync({
      inject: [ENVIRONMENT],
      useFactory: (environment: Environment) => ({
        pinoHttp: {
          level: environment.LOG_LEVEL,
          genReqId: () => randomUUID(),
          customProps: (request) => ({ correlationId: request.id }),
          redact: {
            paths: [
              "req.headers.authorization",
              "req.headers.cookie",
              "res.headers.set-cookie",
            ],
            censor: "[REDACTED]",
          },
        },
      }),
    }),
  ],
  exports: [LoggerModule],
})
export class LoggingModule {}
