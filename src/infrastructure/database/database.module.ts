import { MikroORM } from "@mikro-orm/postgresql";
import {
  Inject,
  Injectable,
  Module,
  type OnApplicationShutdown,
} from "@nestjs/common";
import { ENVIRONMENT } from "../config/config.module";
import type { Environment } from "../config/environment";
import { databaseConfig } from "./database.config";

@Injectable()
class DatabaseLifecycle implements OnApplicationShutdown {
  constructor(@Inject(MikroORM) private readonly orm: MikroORM) {}

  async onApplicationShutdown(): Promise<void> {
    await this.orm.close(true);
  }
}

@Module({
  providers: [
    {
      provide: MikroORM,
      inject: [ENVIRONMENT],
      useFactory: (environment: Environment) =>
        MikroORM.init(databaseConfig(environment)),
    },
    DatabaseLifecycle,
  ],
  exports: [MikroORM],
})
export class DatabaseModule {}
