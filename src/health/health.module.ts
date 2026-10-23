import { Module } from "@nestjs/common";
import { DatabaseModule } from "../infrastructure/database/database.module";
import { LoggingModule } from "../infrastructure/logging/logging.module";
import { SqsModule } from "../infrastructure/sqs/sqs.module";
import { HealthController } from "./health.controller";

@Module({
  imports: [DatabaseModule, SqsModule, LoggingModule],
  controllers: [HealthController],
})
export class HealthModule {}
