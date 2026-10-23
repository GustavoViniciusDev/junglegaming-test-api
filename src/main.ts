import "reflect-metadata";
import { ShutdownSignal } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { Logger } from "nestjs-pino";
import pino from "pino";
import { AppModule } from "./app.module";
import { ENVIRONMENT } from "./infrastructure/config/config.module";
import type { Environment } from "./infrastructure/config/environment";
import { EnvironmentValidationError } from "./infrastructure/config/environment";
import { setupSwagger } from "./infrastructure/http/swagger";

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, {
    bufferLogs: true,
    abortOnError: false,
  });
  app.useLogger(app.get(Logger));
  app.enableShutdownHooks([ShutdownSignal.SIGTERM, ShutdownSignal.SIGINT]);
  const environment = app.get<Environment>(ENVIRONMENT);
  if (environment.SWAGGER_ENABLED) {
    setupSwagger(app);
  }
  await app.listen(environment.PORT, "0.0.0.0");
}

bootstrap().catch((error: unknown) => {
  const message =
    error instanceof EnvironmentValidationError
      ? error.message
      : "Application startup failed; verify configuration and dependency availability";
  pino().fatal(message);
  process.exit(1);
});
