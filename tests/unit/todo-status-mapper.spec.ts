import { expect, test } from "@playwright/test";

/**
 * Unit tests for todo-status-mapper.ts
 * Tests HA ↔ Meitheal status mapping with canonical 4-state model,
 * due date format detection, and round-trip consistency.
 */

// Inline mapper functions — Playwright tests can't import Astro path aliases.

type HAStatus = "needs_action" | "completed";
type MeithealStatus = "backlog" | "pending" | "active" | "complete";

const CANONICAL_STATUSES: MeithealStatus[] = ["backlog", "pending", "active", "complete"];
const LEGACY_ALIASES: Record<string, MeithealStatus> = {
  todo: "pending",
  in_progress: "active",
  done: "complete",
};

function haStatusToMeitheal(haStatus: HAStatus): MeithealStatus {
  switch (haStatus) {
    case "needs_action": return "pending";
    case "completed": return "complete";
    default: return "pending";
  }
}

function meithealStatusToHA(status: MeithealStatus | string): HAStatus {
  // Normalize legacy aliases first
  const canonical = LEGACY_ALIASES[status] ?? status;
  switch (canonical) {
    case "complete": return "completed";
    default: return "needs_action";
  }
}

function normalizeStatus(raw: string): MeithealStatus {
  if (CANONICAL_STATUSES.includes(raw as MeithealStatus)) return raw as MeithealStatus;
  return LEGACY_ALIASES[raw] ?? "pending";
}

function isDueDateTime(due: string): boolean {
  return /[\sT]\d{2}:\d{2}/.test(due);
}

function buildDueServiceData(due?: string | null): Record<string, string> {
  if (!due) return {};
  if (isDueDateTime(due)) return { due_datetime: due };
  return { due_date: due };
}

// ── Canonical Status Mapping ──

test("haStatusToMeitheal: needs_action → pending", () => {
  expect(haStatusToMeitheal("needs_action")).toBe("pending");
});

test("haStatusToMeitheal: completed → complete", () => {
  expect(haStatusToMeitheal("completed")).toBe("complete");
});

test("meithealStatusToHA: backlog → needs_action", () => {
  expect(meithealStatusToHA("backlog")).toBe("needs_action");
});

test("meithealStatusToHA: pending → needs_action", () => {
  expect(meithealStatusToHA("pending")).toBe("needs_action");
});

test("meithealStatusToHA: active → needs_action", () => {
  expect(meithealStatusToHA("active")).toBe("needs_action");
});

test("meithealStatusToHA: complete → completed", () => {
  expect(meithealStatusToHA("complete")).toBe("completed");
});

// ── Legacy Alias Handling ──

test("meithealStatusToHA: legacy 'todo' → needs_action", () => {
  expect(meithealStatusToHA("todo")).toBe("needs_action");
});

test("meithealStatusToHA: legacy 'in_progress' → needs_action", () => {
  expect(meithealStatusToHA("in_progress")).toBe("needs_action");
});

test("meithealStatusToHA: legacy 'done' → completed", () => {
  expect(meithealStatusToHA("done")).toBe("completed");
});

// ── Normalize Status ──

test("normalizeStatus: canonical values pass through", () => {
  for (const s of CANONICAL_STATUSES) {
    expect(normalizeStatus(s)).toBe(s);
  }
});

test("normalizeStatus: todo → pending", () => {
  expect(normalizeStatus("todo")).toBe("pending");
});

test("normalizeStatus: in_progress → active", () => {
  expect(normalizeStatus("in_progress")).toBe("active");
});

test("normalizeStatus: done → complete", () => {
  expect(normalizeStatus("done")).toBe("complete");
});

test("normalizeStatus: unknown → pending", () => {
  expect(normalizeStatus("garbage")).toBe("pending");
});

// ── Due Date Detection ──

test("isDueDateTime: date-only returns false", () => {
  expect(isDueDateTime("2026-03-15")).toBe(false);
});

test("isDueDateTime: T-separator datetime returns true", () => {
  expect(isDueDateTime("2026-03-15T14:30:00")).toBe(true);
});

test("isDueDateTime: space-separator datetime returns true", () => {
  expect(isDueDateTime("2026-03-15 14:30:00")).toBe(true);
});

test("isDueDateTime: ISO with timezone returns true", () => {
  expect(isDueDateTime("2026-03-15T14:30:00+00:00")).toBe(true);
});

test("isDueDateTime: ISO with Z returns true", () => {
  expect(isDueDateTime("2026-03-15T14:30:00Z")).toBe(true);
});

// ── buildDueServiceData ──

test("buildDueServiceData: null returns empty", () => {
  expect(buildDueServiceData(null)).toEqual({});
});

test("buildDueServiceData: undefined returns empty", () => {
  expect(buildDueServiceData(undefined)).toEqual({});
});

test("buildDueServiceData: date-only returns due_date", () => {
  expect(buildDueServiceData("2026-03-15")).toEqual({ due_date: "2026-03-15" });
});

test("buildDueServiceData: datetime returns due_datetime", () => {
  expect(buildDueServiceData("2026-03-15T14:30:00")).toEqual({ due_datetime: "2026-03-15T14:30:00" });
});

// ── Round-trip Consistency ──

test("round-trip: pending → HA → meitheal", () => {
  expect(haStatusToMeitheal(meithealStatusToHA("pending"))).toBe("pending");
});

test("round-trip: complete → HA → meitheal", () => {
  expect(haStatusToMeitheal(meithealStatusToHA("complete"))).toBe("complete");
});

test("round-trip: active is lossy (→ needs_action → pending)", () => {
  const ha = meithealStatusToHA("active");
  expect(ha).toBe("needs_action");
  expect(haStatusToMeitheal(ha)).toBe("pending");
});

test("round-trip: backlog is lossy (→ needs_action → pending)", () => {
  const ha = meithealStatusToHA("backlog");
  expect(ha).toBe("needs_action");
  expect(haStatusToMeitheal(ha)).toBe("pending");
});

test("round-trip: HA needs_action → meitheal → HA", () => {
  expect(meithealStatusToHA(haStatusToMeitheal("needs_action"))).toBe("needs_action");
});

test("round-trip: HA completed → meitheal → HA", () => {
  expect(meithealStatusToHA(haStatusToMeitheal("completed"))).toBe("completed");
});
