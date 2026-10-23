import { SQSClient } from "@aws-sdk/client-sqs";
import {
  Inject,
  Injectable,
  Module,
  type OnApplicationShutdown,
} from "@nestjs/common";
import { ENVIRONMENT } from "../config/config.module";
import type { Environment } from "../config/environment";

@Injectable()
class SqsLifecycle implements OnApplicationShutdown {
  constructor(@Inject(SQSClient) private readonly client: SQSClient) {}

  onApplicationShutdown(): void {
    this.client.destroy();
  }
}

@Module({
  providers: [
    {
      provide: SQSClient,
      inject: [ENVIRONMENT],
      useFactory: (environment: Environment) =>
        new SQSClient({
          region: environment.AWS_REGION,
          endpoint: environment.SQS_ENDPOINT,
          credentials: {
            accessKeyId: environment.AWS_ACCESS_KEY_ID,
            secretAccessKey: environment.AWS_SECRET_ACCESS_KEY,
          },
          maxAttempts: 1,
          requestHandler: {
            connectionTimeout: environment.DEPENDENCY_TIMEOUT_MS,
            requestTimeout: environment.DEPENDENCY_TIMEOUT_MS,
          },
        }),
    },
    SqsLifecycle,
  ],
  exports: [SQSClient],
})
export class SqsModule {}
