import { expect, test } from "@playwright/test";
import {
  createTaskWithFrameworkAndCalendarSync,
  resolveIntegrationOutcome
} from "../../packages/domain-tasks/src";

test("createTaskWithFrameworkAndCalendarSync creates pending plan and events", () => {
  const plan = createTaskWithFrameworkAndCalendarSync({
    title: "Cook dinner",
    frameworkPayload: { rice: 8.5 },
    requestId: "req-1",
    idempotencyKey: "idem-1"
  });

  expect(plan.aggregate.calendarSyncState).toBe("pending");
  expect(plan.events.map((event) => event.eventType)).toEqual([
    "task.created",
    "framework.score.applied",
    "integration.sync.requested"
  ]);
  expect(plan.calendarRequest.idempotencyKey).toBe("idem-1");
});

test("resolveIntegrationOutcome maps success and failures", () => {
  const success = resolveIntegrationOutcome({
    ok: true,
    confirmationId: "confirm-1"
  });
  expect(success.calendarSyncState).toBe("confirmed");
  expect(success.confirmationId).toBe("confirm-1");

  const timeout = resolveIntegrationOutcome({
    ok: false,
    errorCode: "timeout",
    retryable: true,
    retryAfterSeconds: 30
  });
  expect(timeout.calendarSyncState).toBe("failed_retryable");
  expect(timeout.errorCode).toBe("timeout");

  const unauthorized = resolveIntegrationOutcome({
    ok: false,
    errorCode: "unauthorized",
    retryable: false
  });
  expect(unauthorized.calendarSyncState).toBe("failed_terminal");
  expect(unauthorized.errorCode).toBe("unauthorized");
});
