import { readFileSync } from "node:fs"
import { randomUUID } from "node:crypto"
import { DatabaseSync } from "node:sqlite"
import { expect, test } from "@playwright/test"
import { FeedbackQueue } from "../../apps/web/src/domains/support/feedback-queue"
import { parse } from "../../apps/web/node_modules/yaml/dist/index.js"


test("Feedback version context preserves release grammar and canonical Canary receipts in native SQLite", async () => {
  const sqlite = new DatabaseSync(":memory:")
  sqlite.exec(readFileSync(new URL("../../apps/web/drizzle/migrations/0003_feedback_reports.sql", import.meta.url), "utf8"))
  const db = {
    async execute(statement: { sql: string, args: (string | number | null)[] }) {
      const rows = sqlite.prepare(statement.sql).all(...statement.args)
      return { rows, rowsAffected: Number(sqlite.prepare("SELECT changes() AS count").get()!.count) }
    },
  }
  const actor = { installationId: "local", actorId: "synthetic-member", role: "member" as const }
  const admin = { ...actor, actorId: "synthetic-admin", role: "admin" as const }
  const queue = new FeedbackQueue(db as never)
  const contract = parse(readFileSync(new URL("../../apps/web/public/openapi.yaml", import.meta.url), "utf8"))
  const schema = contract.components.schemas.FeedbackSubmission.properties.appVersion
  try {
    for (const [appVersion, accepted] of [
      [undefined, true], ["0.0.1", true], ["1.2.3-beta.1", true], ["1.2.3+build.42", true],
      ["d73084837f30", true], ["01.002.0003", true], ["1.2.3-BETA..", true],
      ["1.2.3-beta+build", false], ["1.2.3-", false], ["d73084837", false], ["d73084837f30d1e8b86af2862473a98668215ded", false],
      ["D73084837F30", false], ["<script>test</script>", false], ["a".repeat(129), false],
      ["d73084837f30\n", false], ["1.2.3\n", false], ["1.2.3\u2028", false],
      ["99999.99999.99999-" + "a".repeat(32), true], ["99999.99999.99999-" + "a".repeat(33), false],
    ] as const) {
      if (appVersion !== undefined) {
        expect(appVersion.length <= schema.maxLength && new RegExp(schema.pattern).test(appVersion)).toBe(accepted)
      }
      const before = sqlite.prepare("SELECT count(*) AS count FROM feedback_reports").get()!.count
      const payload = { submissionId: randomUUID(), category: "problem", message: "Synthetic version contract",
        ...(appVersion ? { appVersion, routeFamily: "settings" } : {}) }
      const first = await queue.submit(actor, payload)
      expect(first.ok).toBe(accepted)
      if (first.ok) {
        const retry = await queue.submit(actor, payload)
        expect(retry).toEqual(first)
        const report = await queue.get(admin, first.value.id)
        expect(report.ok).toBe(true)
        if (report.ok) expect(report.value.appVersion).toBe(appVersion ?? null)
        const exported = await queue.prepareExport(admin, first.value.id, "Reviewed safe text")
        expect(exported.ok).toBe(true)
        if (exported.ok) expect(exported.value).toEqual({ category: "problem", message: "Reviewed safe text",
          appVersion: appVersion ?? null, routeFamily: appVersion ? "settings" : null })
      } else {
        expect(first).toEqual({ ok: false, errorCode: "invalid_input" })
      }
      const after = sqlite.prepare("SELECT count(*) AS count FROM feedback_reports").get()!.count
      expect(after).toBe(Number(before) + (accepted ? 1 : 0))
    }
  } finally { sqlite.close() }
})
