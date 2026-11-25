import test from "node:test"
import assert from "node:assert/strict"
import {
  buildOfflineSyncSummary,
  enqueueOfflineMutation,
  isSafeOfflineMutationUrl,
  sanitizeOfflineBoardId,
} from "./pwa-offline-sync"

test("isSafeOfflineMutationUrl allows same-origin task mutation endpoints only", () => {
  assert.equal(isSafeOfflineMutationUrl("/api/tasks"), true)
  assert.equal(isSafeOfflineMutationUrl("/api/tasks/task_123"), true)
  assert.equal(isSafeOfflineMutationUrl("/api/tasks/MTH-42?refresh=1"), true)

  // Reject cross-origin, protocol-relative, traversal, and non-task APIs
  assert.equal(isSafeOfflineMutationUrl("https://evil.example/api/tasks"), false)
  assert.equal(isSafeOfflineMutationUrl("//evil.example/api/tasks"), false)
  assert.equal(isSafeOfflineMutationUrl("/api/tasks/../settings"), false)
  assert.equal(isSafeOfflineMutationUrl("/api/tasks/..\\settings"), false)
  assert.equal(isSafeOfflineMutationUrl("/api/agent-tokens"), false)
  assert.equal(isSafeOfflineMutationUrl("/api/settings"), false)
  assert.equal(isSafeOfflineMutationUrl("javascript:alert(1)"), false)
})

test("sanitizeOfflineBoardId rejects control characters and invalid board IDs", () => {
  assert.equal(sanitizeOfflineBoardId("household"), "household")
  assert.equal(sanitizeOfflineBoardId("board_01-main"), "board_01-main")
  assert.equal(sanitizeOfflineBoardId("household\r\nX-Injected: 1"), undefined)
  assert.equal(sanitizeOfflineBoardId("../admin"), undefined)
  assert.equal(sanitizeOfflineBoardId("a".repeat(80)), undefined)
})

test("enqueueOfflineMutation rejects unsafe endpoints and oversized payloads", async () => {
  await assert.rejects(
    () =>
      enqueueOfflineMutation({
        url: "https://attacker.invalid/api/tasks",
        method: "POST",
        body: "{}",
      }),
    /Unsupported offline mutation endpoint/,
  )
  await assert.rejects(
    () =>
      enqueueOfflineMutation({
        url: "/api/tasks",
        method: "POST",
        body: "x".repeat(70_000),
      }),
    /Offline payload exceeds maximum size/,
  )
})

test("buildOfflineSyncSummary produces clear singular and plural messages", () => {
  assert.equal(buildOfflineSyncSummary(0, 1), "Synced 1 offline change")
  assert.equal(buildOfflineSyncSummary(0, 3), "Synced 3 offline changes")
  assert.equal(
    buildOfflineSyncSummary(1, 0),
    "Offline mode — 1 pending change will sync automatically when back online.",
  )
  assert.equal(
    buildOfflineSyncSummary(4, 0),
    "Offline mode — 4 pending changes will sync automatically when back online.",
  )
  assert.equal(
    buildOfflineSyncSummary(0, 0),
    "Offline mode — showing cached app shell. Changes sync when back online.",
  )
})
