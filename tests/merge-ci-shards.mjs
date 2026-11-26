import { execFileSync } from "node:child_process"
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { basename, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { mergeCoverageMaps } from "./coverage-report.mjs"
import { artifactDigest, shardIdentity, testedTree, testsInReport, validateShardReports } from "./ci-shards.mjs"

const [directory, output, total] = process.argv.slice(2)
const count = Number(total)
if (!directory || !output || !Number.isSafeInteger(count) || count < 1) {
  throw new Error("Usage: node tests/merge-ci-shards.mjs ARTIFACT_DIRECTORY OUTPUT_DIRECTORY SHARDS")
}

const cwd = fileURLToPath(new URL(".", import.meta.url))
const listed = JSON.parse(execFileSync(process.execPath, [
  join(cwd, "node_modules/@playwright/test/cli.js"), "test", "--list", "--reporter=json",
], { cwd, env: { ...process.env, MEITHEAL_TEST_BROWSER: "1" }, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }))
const files = [...new Set(listed.suites.map(suite => suite.file))]
const cases = testsInReport(listed)
if (!files.length || !cases.length) throw new Error("No specs or test cases were discovered")

const shards = Array.from({ length: count }, (_, position) => join(directory, "shard-" + (position + 1)))
const found = readdirSync(directory).sort()
if (found.join("\n") !== shards.map(shard => basename(shard)).sort().join("\n")) {
  throw new Error("Missing or unexpected shard artifact")
}
const reports = shards.map(shard => JSON.parse(readFileSync(join(shard, "result.json"), "utf8")))
const identity = shardIdentity(testedTree(resolve(cwd, "..")))
const outcomes = validateShardReports(reports, files, cases, count, identity)
mkdirSync(output, { recursive: true })
writeFileSync(join(output, "cases.json"), JSON.stringify(outcomes))
const maps = shards.map(shard => join(shard, "coverage.json"))
if (maps.some((map, position) => artifactDigest(map) !== reports[position].coverageDigest)) {
  throw new Error("Coverage map does not match the corresponding shard report")
}
const coverage = mergeCoverageMaps(maps, join(output, "lcov.info"))
console.log(JSON.stringify({ specs: files.length, tests: cases.length, shards: count, coverage }))
