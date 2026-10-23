import { MikroORM } from "@mikro-orm/postgresql";
import { Inject, Injectable } from "@nestjs/common";
import type {
  OutboxPublishBatch,
  OutboxPublishingStore,
} from "../application/publish-outbox-messages";
import { nextOutboxAttemptAt } from "../application/outbox-retry-policy";
import { OutboxMessageRecord } from "../../infrastructure/database/entities";
import type { IntegrationEventJSON } from "../../shared/domain/integration-event";
import { outboxMessageFromRecord } from "../../infrastructure/database/domain-mappers";

interface DueOutboxRow {
  id: string;
}

@Injectable()
export class MikroOrmOutboxPublishingStore implements OutboxPublishingStore {
  constructor(@Inject(MikroORM) private readonly orm: MikroORM) {}

  async findOldestUnpublishedOccurredAt(): Promise<Date | null> {
    const em = this.orm.em.fork({ clear: true });
    try {
      const rows = (await em.getConnection().execute(
        `select occurred_at as "occurredAt"
         from outbox_messages
         where published_at is null
         order by occurred_at, id
         limit 1`,
      )) as Array<{ occurredAt: Date | string }>;
      const occurredAt = rows[0]?.occurredAt;
      return occurredAt === undefined
        ? null
        : occurredAt instanceof Date
          ? occurredAt
          : new Date(occurredAt);
    } finally {
      em.clear();
    }
  }

  async publishDueMessages(
    input: Parameters<OutboxPublishingStore["publishDueMessages"]>[0],
  ): Promise<OutboxPublishBatch> {
    const outcomes: OutboxPublishBatch["outcomes"] = [];
    for (let index = 0; index < input.batchSize; index += 1) {
      const outcome = await this.publishNext(input);
      if (outcome === null) break;
      outcomes.push(outcome);
    }
    return { outcomes };
  }

  private async publishNext(
    input: Parameters<OutboxPublishingStore["publishDueMessages"]>[0],
  ): Promise<OutboxPublishBatch["outcomes"][number] | null> {
    const em = this.orm.em.fork({ clear: true });
    return em.transactional(async (transactionalEm) => {
      const dueRows = (await transactionalEm.getConnection().execute(
        `select candidate.id
         from outbox_messages as candidate
         where candidate.published_at is null
           and candidate.next_attempt_at <= ?
           and not exists (
             select 1
             from outbox_messages as earlier
             where earlier.aggregate_id = candidate.aggregate_id
               and earlier.published_at is null
               and (earlier.occurred_at, earlier.id) < (candidate.occurred_at, candidate.id)
           )
         order by candidate.next_attempt_at, candidate.occurred_at, candidate.id
         limit 1
         for update of candidate skip locked`,
        [input.now],
        "all",
        transactionalEm.getTransactionContext(),
      )) as DueOutboxRow[];
      const id = dueRows[0]?.id;
      if (id === undefined) return null;

      const record = await transactionalEm.findOneOrFail(
        OutboxMessageRecord,
        id,
      );
      const message = outboxMessageFromRecord(record);
      const event: IntegrationEventJSON = {
        id: message.id,
        aggregateId: message.aggregateId,
        eventType: message.eventType,
        occurredAt: message.occurredAt.toISOString(),
        payload: message.payload,
      };

      let publishError: unknown;
      let publishFailed = false;
      try {
        await input.publish(event);
      } catch (error) {
        publishFailed = true;
        publishError = error;
      }
      if (publishFailed) {
        const attempts = message.attempts + 1;
        const nextAttemptAt = nextOutboxAttemptAt(
          input.now,
          attempts,
          input.retry,
        );
        await transactionalEm
          .getConnection()
          .execute(
            "update outbox_messages set attempts = ?, next_attempt_at = ? where id = ? and published_at is null",
            [attempts, nextAttemptAt, message.id],
            "run",
            transactionalEm.getTransactionContext(),
          );
        return {
          id: message.id,
          aggregateId: message.aggregateId,
          eventType: message.eventType,
          attempts,
          published: false,
          errorType:
            publishError instanceof Error ? publishError.name : "UnknownError",
        };
      }

      const publishedAt = new Date(
        Math.max(input.now.getTime(), message.occurredAt.getTime()),
      );
      await transactionalEm
        .getConnection()
        .execute(
          "update outbox_messages set published_at = ? where id = ? and published_at is null",
          [publishedAt, message.id],
          "run",
          transactionalEm.getTransactionContext(),
        );
      return {
        id: message.id,
        aggregateId: message.aggregateId,
        eventType: message.eventType,
        attempts: message.attempts,
        published: true,
      };
    });
  }
}
