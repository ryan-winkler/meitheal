import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import type { CalendarIntegrationAdapter } from "../../packages/integration-core/src";
import { createTaskAndSyncCalendar } from "../../apps/web/src/domains/tasks/task-sync-service";
import { TaskRepository } from "../../apps/web/src/domains/tasks/persistence/task-repository";
import {
  ensureSchema,
  getPersistenceClient,
  persistManualCalendarConfirmation,
  resetPersistenceForTests
} from "../../apps/web/src/domains/tasks/persistence/store";
import { calendarConfirmations, integrationAttempts, tasks } from "../../apps/web/drizzle/schema";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/libsql";

function getDb() {
  return drizzle(getPersistenceClient());
}

function makeDbUrl(label: string): string {
  return `file:${path.join(os.tmpdir(), `meitheal-${label}-${Date.now()}-${Math.random()}.db`)}`;
}

test.beforeEach(async () => {
  process.env.MEITHEAL_DB_URL = makeDbUrl("task-sync");
  resetPersistenceForTests();
  await ensureSchema();
});

test("createTaskAndSyncCalendar persists task/events/attempt/confirmation on success", async () => {
  const adapter: CalendarIntegrationAdapter = {
    async createEvent() {
      return {
        ok: true,
        confirmationId: "confirm-success-1",
        providerEventId: "ha-event-1",
        raw: { response: "ok" }
      };
    }
  };

  const result = await createTaskAndSyncCalendar(
    {
      title: "Pay bills",
      requestId: "req-success-1",
      idempotencyKey: "idem-success-1",
      frameworkPayload: { rice: 7 },
      calendarDefaults: {
        enabled: true,
        entityId: "calendar.home",
        defaultDurationMinutes: 20,
        timezone: "Europe/Dublin"
      }
    },
    adapter
  );

  expect(result.integration.calendarSyncState).toBe("confirmed");
  expect(result.integration.confirmationId).toBe("confirm-success-1");

  const db = getDb();
  const [taskRow] = await db.select().from(tasks).where(eq(tasks.id, result.task.id)).limit(1);
  expect(taskRow?.calendarSyncState).toBe("confirmed");

  const [attempt] = await db
    .select()
    .from(integrationAttempts)
    .where(eq(integrationAttempts.taskId, result.task.id))
    .limit(1);
  expect(attempt?.status).toBe("succeeded");

  const [confirmation] = await db
    .select()
    .from(calendarConfirmations)
    .where(eq(calendarConfirmations.taskId, result.task.id))
    .limit(1);
  expect(confirmation?.confirmationId).toBe("confirm-success-1");
});

test("createTaskAndSyncCalendar returns idempotent replay and avoids duplicate HA calls", async () => {
  let calls = 0;
  const adapter: CalendarIntegrationAdapter = {
    async createEvent() {
      calls += 1;
      return {
        ok: true,
        confirmationId: "confirm-idem-1"
      };
    }
  };

  const baseInput = {
    title: "Idempotent task",
    requestId: "req-idem-1",
    idempotencyKey: "idem-shared-1",
    frameworkPayload: { rice: 4 },
    calendarDefaults: {
      enabled: true,
      entityId: "calendar.home",
      defaultDurationMinutes: 15,
      timezone: "Europe/Dublin"
    }
  };

  const first = await createTaskAndSyncCalendar(baseInput, adapter);
  const second = await createTaskAndSyncCalendar(baseInput, adapter);

  expect(first.idempotentReplay).toBeFalsy();
  expect(second.idempotentReplay).toBeTruthy();
  expect(calls).toBe(1);
  expect(second.integration.calendarSyncState).toBe("confirmed");
});

test("failed HA call marks task as failed_retryable and manual confirmation is idempotent", async () => {
  const adapter: CalendarIntegrationAdapter = {
    async createEvent() {
      return {
        ok: false,
        errorCode: "timeout",
        retryable: true,
        retryAfterSeconds: 30
      };
    }
  };

  const created = await createTaskAndSyncCalendar(
    {
      title: "Timeout task",
      requestId: "req-timeout-1",
      idempotencyKey: "idem-timeout-1",
      frameworkPayload: { rice: 2 },
      calendarDefaults: {
        enabled: true,
        entityId: "calendar.home",
        defaultDurationMinutes: 15,
        timezone: "Europe/Dublin"
      }
    },
    adapter
  );

  expect(created.integration.calendarSyncState).toBe("failed_retryable");
  expect(created.integration.errorCode).toBe("timeout");

  const confirmation = {
    taskId: created.task.id,
    requestId: "req-confirm-1",
    confirmationId: "manual-confirm-1",
    providerEventId: "provider-1",
  }
  const confirmations = await Promise.all([
    persistManualCalendarConfirmation(confirmation),
    persistManualCalendarConfirmation(confirmation),
  ])
  expect(confirmations.map(result => result.alreadyExisted).sort()).toEqual([false, true])
  expect((await persistManualCalendarConfirmation(confirmation)).alreadyExisted).toBe(true)

  const db = getDb();
  const [taskRow] = await db.select().from(tasks).where(eq(tasks.id, created.task.id)).limit(1);
  expect(taskRow?.calendarSyncState).toBe("confirmed");
});

test("manual confirmation rejects unknown task ids", async () => {
  await expect(
    persistManualCalendarConfirmation({
      taskId: "task-does-not-exist",
      requestId: "req-missing-task",
      confirmationId: "confirm-missing-task"
    })
  ).rejects.toThrow(/TASK_NOT_FOUND/);

  const client = getPersistenceClient();
  const result = await client.execute("SELECT COUNT(*) AS count FROM calendar_confirmations");
  const count = Number((result.rows[0] as Record<string, unknown> | undefined)?.count ?? 0);
  expect(count).toBe(0);
});

test("concurrent retries share one task and one calendar write", async () => {
  let calendarWrites = 0
  const adapter: CalendarIntegrationAdapter = {
    async createEvent() {
      calendarWrites += 1
      return { ok: true, confirmationId: "race-confirmation" }
    },
  }
  const input = {
    title: "Retry fixture",
    requestId: "race-request",
    idempotencyKey: "race-idempotency",
    calendarDefaults: {
      enabled: true,
      entityId: "calendar.home",
      defaultDurationMinutes: 15,
      timezone: "Europe/Dublin",
    },
  }

  const [first, second] = await Promise.all([
    createTaskAndSyncCalendar(input, adapter),
    createTaskAndSyncCalendar(input, adapter),
  ])

  expect(first.task.id).toBe(second.task.id)
  expect(calendarWrites).toBe(1)
  expect([first.idempotentReplay, second.idempotentReplay].sort()).toEqual([false, true])
})

test("retention rolls back dependent deletes if task removal fails", async () => {
  const client = getPersistenceClient()
  const repository = new TaskRepository(client)
  await client.batch([
    "INSERT INTO tasks(id, title, status, idempotency_key, request_id, created_at, updated_at) VALUES ('expired', 'Old task', 'complete', 'expired', 'req-old', 1, 1)",
    "INSERT INTO tasks(id, title, status, idempotency_key, request_id, created_at, updated_at) VALUES ('active', 'Current task', 'active', 'active', 'req-active', 1, 1)",
    "INSERT INTO comments(task_id, content) VALUES ('expired', 'Keep until committed')",
    "CREATE TRIGGER fixture_block_delete BEFORE DELETE ON tasks WHEN OLD.id = 'expired' BEGIN SELECT RAISE(ABORT, 'retention fixture blocked'); END",
  ], "write")

  await expect(repository.deleteCompletedBefore(2)).rejects.toThrow("retention fixture blocked")
  expect((await client.execute("SELECT content FROM comments WHERE task_id = 'expired'")).rows).toHaveLength(1)

  await client.execute("DROP TRIGGER fixture_block_delete")
  await expect(repository.deleteCompletedBefore(2)).resolves.toBe(1)
  expect((await client.execute("SELECT id FROM tasks")).rows.map(row => row.id)).toEqual(["active"])
  expect((await client.execute("SELECT content FROM comments WHERE task_id = 'expired'")).rows).toHaveLength(0)
})
