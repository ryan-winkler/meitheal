import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "@playwright/test"

const { parse } = createRequire(new URL("../../apps/web/package.json", import.meta.url))("yaml")
const workflow = parse(readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8"))
const steps = workflow.jobs["security-audit"].steps as Array<{ name?: string; run?: string }>
const script = steps.find(step => step.name === "Audit dependency advisories")?.run
if (!script) throw new Error("The dependency audit step is missing")

const expiry = Date.parse("2026-11-24T00:00:00Z") / 1000
const lookup = "-r why --prod picomatch --json"
const exception = "audit --ignore GHSA-fc5q-39xc-vjpf"
const cases = [
  { name: "only exempts the build-only advisory before expiry", graph: "[]", now: expiry - 1, audit: 0, status: 0, calls: [lookup, exception, "audit"] },
  { name: "audits production Picomatch without an exception", graph: '[{"name":"picomatch"}]', now: expiry - 1, audit: 1, status: 1, calls: [lookup, "audit"] },
  { name: "restores the complete audit at expiry", graph: "[]", now: expiry, audit: 0, status: 0, calls: [lookup, "audit"] },
  { name: "retains failures from other advisories", graph: "[]", now: expiry - 1, audit: 1, status: 1, calls: [lookup, exception, "audit"] },
  { name: "retains registry errors", graph: "[]", now: expiry - 1, audit: 70, status: 70, calls: [lookup, exception, "audit"] },
  { name: "rejects a failed production lookup", graph: "[]", now: expiry - 1, audit: 0, lookupStatus: 19, status: 19, calls: [lookup] },
  { name: "rejects malformed production lookup JSON", graph: "invalid", now: expiry - 1, audit: 0, status: "failure", calls: [lookup] },
  { name: "rejects a non-array production lookup", graph: "{}", now: expiry - 1, audit: 0, status: 1, calls: [lookup] },
]

for (const scenario of cases) {
  test(`dependency audit ${scenario.name}`, () => {
    const work = mkdtempSync(join(tmpdir(), "meitheal-audit-policy-"))
    try {
      writeFileSync(join(work, "pnpm"), `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$AUDIT_TEST_CALLS"
case "$*" in
  "${lookup}") printf '%s\\n' "$AUDIT_TEST_GRAPH"; exit "$AUDIT_TEST_LOOKUP_STATUS" ;;
  "${exception}") exit 0 ;;
  "audit") exit "$AUDIT_TEST_EXIT" ;;
  *) exit 92 ;;
esac
`, { mode: 0o700 })
      writeFileSync(join(work, "date"), `#!/usr/bin/env bash
if [[ "$*" == "-u +%s" ]]; then
  printf '%s\\n' "$AUDIT_TEST_NOW"
elif [[ "$*" == "-u -d 2026-11-24T00:00:00Z +%s" ]]; then
  printf '%s\\n' '${expiry}'
else
  exit 93
fi
`, { mode: 0o700 })
      const calls = join(work, "calls")
      const result = spawnSync("bash", ["-e", "-o", "pipefail", "-c", script], {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${work}:${process.env.PATH}`,
          AUDIT_TEST_CALLS: calls,
          AUDIT_TEST_GRAPH: scenario.graph,
          AUDIT_TEST_LOOKUP_STATUS: String(scenario.lookupStatus ?? 0),
          AUDIT_TEST_NOW: String(scenario.now),
          AUDIT_TEST_EXIT: String(scenario.audit),
        },
      })
      if (scenario.status === "failure") expect(result.status, result.stderr).toBeGreaterThan(0)
      else expect(result.status, result.stderr).toBe(scenario.status)
      expect(readFileSync(calls, "utf8").trim().split("\n")).toEqual(scenario.calls)
    } finally {
      rmSync(work, { recursive: true, force: true })
    }
  })
}
