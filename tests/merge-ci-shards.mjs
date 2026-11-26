import { execFileSync } from "node:child_process"
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { basename, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { artifactDigest, loadPilotShardTimings, shardIdentity, testedTree, testInventory, validateShardReports } from "./ci-shards.mjs"
import { PILOT_COVERAGE_ARCHIVE, replayPilotCoverage } from "./pilot-coverage.mjs"

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
const cases = testInventory(listed)
if (!files.length || !cases.length) throw new Error("No specs or test cases were discovered")

const shards = Array.from({ length: count }, (_, position) => join(directory, "shard-" + (position + 1)))
const found = readdirSync(directory).sort()
if (found.join("\n") !== shards.map(shard => basename(shard)).sort().join("\n")) {
  throw new Error("Missing or unexpected shard artifact")
}
const reports = shards.map(shard => JSON.parse(readFileSync(join(shard, "result.json"), "utf8")))
const identity = shardIdentity(testedTree(resolve(cwd, "..")))
const timings = count > 1 ? loadPilotShardTimings() : {}
const outcomes = validateShardReports(reports, files, cases, count, identity, timings)
mkdirSync(output, { recursive: true })
writeFileSync(join(output, "cases.json"), JSON.stringify(outcomes))
const archives = shards.map((shard, index) => ({
  path: join(shard, PILOT_COVERAGE_ARCHIVE),
  files: reports[index].results.map(result => result.file),
}))
if (archives.some((archive, index) => artifactDigest(archive.path) !== reports[index].coverageDigest)) {
  throw new Error("Coverage input does not match the corresponding shard report")
}
const coverage = await replayPilotCoverage(archives, files, join(output, "lcov.info"), resolve(cwd, ".."))
console.log(JSON.stringify({ specs: files.length, tests: cases.length, shards: count, coverage }))
