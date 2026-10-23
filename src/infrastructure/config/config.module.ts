import { Global, Module } from "@nestjs/common";
import { parseEnvironment } from "./environment";

export const ENVIRONMENT = Symbol("ENVIRONMENT");

@Global()
@Module({
  providers: [
    { provide: ENVIRONMENT, useFactory: () => parseEnvironment(process.env) },
  ],
  exports: [ENVIRONMENT],
})
export class ConfigModule {}
