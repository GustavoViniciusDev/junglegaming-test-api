import { Migrator } from "@mikro-orm/migrations";
import { defineConfig } from "@mikro-orm/postgresql";
import pino from "pino";
import type { Environment } from "../config/environment";
import {
  InboxMessageRecord,
  OutboxMessageRecord,
  WagerTransactionRecord,
  WalletLedgerEntryRecord,
  WalletRecord,
} from "./entities";

export function databaseConfig(environment: Environment) {
  const logger = pino({ level: environment.LOG_LEVEL });
  return defineConfig({
    host: environment.POSTGRES_HOST,
    port: environment.POSTGRES_PORT,
    dbName: environment.POSTGRES_DB,
    user: environment.POSTGRES_USER,
    password: environment.POSTGRES_PASSWORD,
    entities: [
      WalletRecord,
      WagerTransactionRecord,
      WalletLedgerEntryRecord,
      InboxMessageRecord,
      OutboxMessageRecord,
    ],
    allowGlobalContext: false,
    extensions: [Migrator],
    connect: false,
    pool: {
      min: 0,
      max: 10,
      acquireTimeoutMillis: environment.DEPENDENCY_TIMEOUT_MS,
    },
    driverOptions: {
      connection: {
        connectionTimeoutMillis: environment.DEPENDENCY_TIMEOUT_MS,
        statement_timeout: environment.DEPENDENCY_TIMEOUT_MS,
      },
    },
    migrations: {
      path: "dist/src/infrastructure/database/migrations",
      pathTs: "src/infrastructure/database/migrations",
      transactional: true,
      allOrNothing: true,
      emit: "ts",
    },
    logger: (message) => logger.debug({ context: "MikroORM" }, message),
  });
}
