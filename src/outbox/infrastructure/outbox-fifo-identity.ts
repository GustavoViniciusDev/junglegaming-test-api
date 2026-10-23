import { createHash } from "node:crypto";
import type { IntegrationEventJSON } from "../../shared/domain/integration-event";

export function outboxFifoIdentity(event: IntegrationEventJSON): {
  messageGroupId: string;
  messageDeduplicationId: string;
} {
  return {
    messageGroupId: createHash("sha256")
      .update(event.aggregateId, "utf8")
      .digest("hex"),
    messageDeduplicationId: event.id,
  };
}
