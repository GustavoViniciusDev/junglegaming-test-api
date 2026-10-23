import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import type { INestApplication } from "@nestjs/common";

export function setupSwagger(app: INestApplication): void {
  const config = new DocumentBuilder()
    .setTitle("Jungle Gaming Wagering API")
    .setDescription(
      "Distributed wagering transaction processor with persistent idempotency, wallet-level concurrency control, immutable ledger, Inbox/Outbox messaging and financial reconciliation.",
    )
    .setVersion("1.0.0")
    .addTag("Wallets")
    .addTag("Ledger")
    .addTag("Wagering")
    .addTag("Reconciliation")
    .addTag("Health")
    .addTag("Observability")
    .build();
  const document = SwaggerModule.createDocument(app, config, {
    autoTagControllers: false,
  });
  SwaggerModule.setup("docs", app, document, {
    jsonDocumentUrl: "docs-json",
  });
}
