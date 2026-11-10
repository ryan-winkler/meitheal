import { randomUUID } from "node:crypto"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout } from "node:timers/promises"
import { expect, test } from "@playwright/test"
import {
  FeedbackQueue,
  FEEDBACK_PAGE_SIZE,
  MAX_FEEDBACK_MESSAGE_BYTES,
  MAX_FEEDBACK_REPORTS,
  MAX_FEEDBACK_RESERVED_BYTES,
  type VerifiedFeedbackActor,
} from "../../apps/web/src/domains/support/feedback-queue"
import {
  getPersistenceClient,
  resetPersistenceForTests,
} from "../../apps/web/src/domains/tasks/persistence/store"

const member: VerifiedFeedbackActor = { installationId: "install-a", actorId: "member", role: "member" }
const admin: VerifiedFeedbackActor = { ...member, actorId: "admin", role: "admin" }
const otherAdmin: VerifiedFeedbackActor = { ...admin, installationId: "install-b" }
const payload = () => ({ submissionId: randomUUID(), category: "problem", message: "Card did not open" })
const migration = new URL("../../apps/web/drizzle/migrations/0003_feedback_reports.sql", import.meta.url)

const feedbackTest = test.extend<{
  clients: { first: ReturnType<typeof getPersistenceClient>, second: ReturnType<typeof getPersistenceClient> }
}>({
  clients: async ({}, use) => {
    const directory = await mkdtemp(join(tmpdir(), "meitheal-feedback-"))
    const previous = process.env.MEITHEAL_DB_URL
    process.env.MEITHEAL_DB_URL = `file:${join(directory, "feedback.db")}`
    resetPersistenceForTests()
    const first = getPersistenceClient()
    resetPersistenceForTests()
    const second = getPersistenceClient()

    try {
      await first.executeMultiple(await readFile(migration, "utf8"))
      await use({ first, second })
    } finally {
      second.close()
      first.close()
      resetPersistenceForTests()
      if (previous === undefined) delete process.env.MEITHEAL_DB_URL
      else process.env.MEITHEAL_DB_URL = previous
      await rm(directory, { recursive: true, force: true })
    }
  },
})

feedbackTest("returns the original receipt on a retry through a separate connection", async ({ clients }) => {
  const first = new FeedbackQueue(clients.first)
  const second = new FeedbackQueue(clients.second)
  const input = payload()
  const [created, retried] = await Promise.all([
    first.submit(member, input),
    second.submit(member, { ...input, message: `  ${input.message}\r\n` }),
  ])
  expect(created.ok).toBe(true)
  expect(retried).toEqual(created)
  expect(await second.submit(member, { ...input, message: "Different report" }))
    .toEqual({ ok: false, errorCode: "conflict" })
  const anotherMember = { ...member, actorId: "another-member" }
  const anotherInstall = { ...member, installationId: otherAdmin.installationId }
  const separateActor = await first.submit(anotherMember, input)
  const separateInstall = await first.submit(anotherInstall, input)
  expect(separateActor.ok && separateInstall.ok).toBe(true)
  expect(separateActor).not.toEqual(created)
  expect(separateInstall).not.toEqual(created)
  expect((await clients.first.execute("SELECT id FROM feedback_reports")).rows).toHaveLength(3)
})

feedbackTest("retries a busy writer without dropping or duplicating the report", async ({ clients }) => {
  const lock = await clients.first.transaction("write")
  try {
    const queue = new FeedbackQueue(clients.second)
    const input = payload()
    const [submission, release] = await Promise.allSettled([
      queue.submit(member, input),
      setTimeout(25).then(() => lock.commit()),
    ])
    expect(release.status).toBe("fulfilled")
    if (submission.status === "rejected") throw submission.reason
    expect(submission.value.ok).toBe(true)
    expect((await clients.second.execute("SELECT id FROM feedback_reports")).rows).toHaveLength(1)
  } finally {
    lock.close()
  }
})

feedbackTest("authorizes before storage and rejects unbounded or unexpected context", async ({ clients }) => {
  const queue = new FeedbackQueue(clients.first)
  const input = payload()
  expect(await queue.submit(null, input)).toEqual({ ok: false, errorCode: "forbidden" })
  expect(await queue.list(member)).toEqual({ ok: false, errorCode: "forbidden" })

  for (const invalid of [
    { ...input, actorId: admin.actorId },
    { ...input, message: "é".repeat(MAX_FEEDBACK_MESSAGE_BYTES / 2 + 1) },
    { ...input, routeFamily: "https://home.invalid/settings" },
    { ...input, appVersion: "admin@example.invalid" },
    { ...input, message: " \n\t " },
    { ...input, category: "security" },
  ]) {
    expect(await queue.submit(member, invalid)).toEqual({ ok: false, errorCode: "invalid_input" })
  }
  expect((await clients.first.execute("SELECT id FROM feedback_reports")).rows).toHaveLength(0)
})

feedbackTest("records the review actors, limits closed deletion and exports only reviewed text", async ({ clients }) => {
  const queue = new FeedbackQueue(clients.first)
  const input = { ...payload(), message: "Private text <b>retained literally</b>", appVersion: "1.2.3", routeFamily: "tasks" }
  const submitted = await queue.submit(member, input)
  if (!submitted.ok) throw new Error(submitted.errorCode)
  const { id } = submitted.value
  expect(Object.keys(submitted.value).sort()).toEqual(["id", "receivedAt"])

  expect(await queue.get(member, id)).toEqual({ ok: false, errorCode: "forbidden" })
  expect(await queue.review(member, id, "in_progress")).toEqual({ ok: false, errorCode: "forbidden" })
  expect(await queue.prepareExport(member, id, "Safe")).toEqual({ ok: false, errorCode: "forbidden" })
  expect(await queue.get(otherAdmin, id)).toEqual({ ok: false, errorCode: "not_found" })
  expect(await queue.review(otherAdmin, id, "in_progress")).toEqual({ ok: false, errorCode: "not_found" })
  expect(await queue.prepareExport(otherAdmin, id, "Safe")).toEqual({ ok: false, errorCode: "not_found" })
  expect(await queue.deleteClosed(admin, id)).toEqual({ ok: false, errorCode: "conflict" })
  expect(await queue.review(admin, id, "resolved", "Resolved")).toEqual({ ok: false, errorCode: "conflict" })

  expect(await queue.review(admin, id, "in_progress"))
    .toMatchObject({ ok: true, value: { state: "in_progress", claimedBy: admin.actorId, message: input.message } })
  expect(await queue.review(admin, id, "in_progress")).toEqual({ ok: false, errorCode: "conflict" })
  expect(await queue.review(admin, id, "resolved", " ")).toEqual({ ok: false, errorCode: "invalid_input" })
  const closer = { ...admin, actorId: "second-admin" }
  expect(await queue.review(closer, id, "resolved", "Private decision"))
    .toMatchObject({ ok: true, value: { state: "resolved", claimedBy: admin.actorId, closedBy: closer.actorId } })

  expect(await queue.prepareExport(admin, id, "Reviewed summary")).toEqual({
    ok: true,
    value: { category: "problem", message: "Reviewed summary", appVersion: "1.2.3", routeFamily: "tasks" },
  })
  expect(await queue.deleteClosed(otherAdmin, id)).toEqual({ ok: false, errorCode: "not_found" })
  expect(await queue.deleteClosed(admin, id)).toEqual({ ok: true, value: null })
  expect(await queue.get(admin, id)).toEqual({ ok: false, errorCode: "not_found" })
})

feedbackTest("paginates equal timestamps and lets only one connection take the last quota slot", async ({ clients }) => {
  const first = new FeedbackQueue(clients.first)
  const second = new FeedbackQueue(clients.second)
  await clients.first.execute({
    sql: `WITH RECURSIVE sequence(n) AS (
      SELECT 1 UNION ALL SELECT n + 1 FROM sequence WHERE n < ?
    ) INSERT INTO feedback_reports (
      id, installation_id, submitter_id, submission_id, digest, reserved_bytes, category, message, created_at
    ) SELECT printf('00000000-0000-4000-8000-%012d', n), ?, ?, CAST(n AS TEXT),
      'fixture', 1025, 'problem', 'existing', 1 FROM sequence`,
    args: [MAX_FEEDBACK_REPORTS - 1, member.installationId, member.actorId],
  })
  const input = payload()
  const [accepted, rejected] = await Promise.all([first.submit(member, input), second.submit(member, payload())])
  expect(accepted.ok).toBe(true)
  expect(rejected).toEqual({ ok: false, errorCode: "queue_full" })
  expect(await second.submit(member, input)).toEqual(accepted)
  expect(await second.submit(member, { ...input, message: "Conflicting report" }))
    .toEqual({ ok: false, errorCode: "conflict" })

  const page = await first.list(admin, { state: "open" })
  if (!page.ok || !page.value.nextCursor) throw new Error("Missing first page or cursor")
  const next = await first.list(admin, { state: "open", cursor: page.value.nextCursor })
  if (!next.ok) throw new Error(next.errorCode)
  const ids = [...page.value.reports, ...next.value.reports].map(report => report.id)
  expect(ids).toHaveLength(FEEDBACK_PAGE_SIZE * 2)
  expect(new Set(ids).size).toBe(ids.length)
  expect(await first.list(otherAdmin)).toEqual({ ok: true, value: { reports: [], nextCursor: null } })
  expect((await clients.first.execute("SELECT id FROM feedback_reports")).rows).toHaveLength(MAX_FEEDBACK_REPORTS)
})

feedbackTest("enforces the reserved byte quota independently of the report count", async ({ clients }) => {
  const queue = new FeedbackQueue(clients.first)
  await clients.first.execute({
    sql: `INSERT INTO feedback_reports (
      id, installation_id, submitter_id, submission_id, digest, reserved_bytes, category, message, created_at
    ) VALUES (?, ?, ?, ?, 'fixture', ?, 'problem', 'existing', 1)`,
    args: [randomUUID(), member.installationId, member.actorId, randomUUID(), MAX_FEEDBACK_RESERVED_BYTES - 1],
  })
  expect(await queue.submit(member, payload())).toEqual({ ok: false, errorCode: "queue_full" })
  expect((await clients.first.execute("SELECT id FROM feedback_reports")).rows).toHaveLength(1)
})
