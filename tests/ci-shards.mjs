import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"

export function testedTree(repoRoot) {
  return execFileSync("git", ["rev-parse", "HEAD^{tree}"], { cwd: repoRoot, encoding: "utf8" }).trim()
}

export function artifactDigest(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex")
}

export function shardIdentity(tree) {
  return { tree, run: process.env.GITHUB_RUN_ID ?? "local", attempt: process.env.GITHUB_RUN_ATTEMPT ?? "1" }
}

export function parseShard(value, fileCount) {
  const match = /^([1-9]\d*)\/([1-9]\d*)$/.exec(value)
  if (!match) throw new Error("Expected a shard in index/count form")
  const index = Number(match[1])
  const count = Number(match[2])
  if (index > count || count > fileCount) throw new Error("Shard must select at least one spec")
  return { index, count }
}

export function testsInReport(report) {
  const cases = []
  function visit(suite) {
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests) {
        const last = test.results.at(-1)
        const failure = last?.errors?.find(error => error.location)?.location
        cases.push({
          id: JSON.stringify([spec.id, test.projectId]),
          file: spec.file,
          title: spec.title,
          outcome: test.status,
          attempts: test.results.map(result => result.status),
          ...(failure ? { line: failure.line, column: failure.column } : {}),
        })
      }
    }
    for (const child of suite.suites ?? []) visit(child)
  }
  for (const suite of report.suites) visit(suite)
  return cases
}

/**
 * @param {string[]} files
 * @param {{ index: number, count: number }} shard
 */
export function pathsInShard(files, { index, count }) {
  return files.filter((_, position) => position % count === index - 1)
}

export function validateShardReports(reports, files, cases, count, identity) {
  if (reports.length !== count) throw new Error("Incorrect number of shard reports")
  const expectedCases = new Map(cases.map(test => [test.id, test.file]))
  if (expectedCases.size !== cases.length) throw new Error("Duplicate discovered test identity")
  const observedCases = new Map()
  const shardIndexes = new Set()

  for (const report of reports) {
    const { shard, results } = report
    if (shard.count !== count || !Number.isInteger(shard.index) || shard.index < 1 ||
        shard.index > count || shardIndexes.has(shard.index)) {
      throw new Error("Invalid or duplicate shard")
    }
    shardIndexes.add(shard.index)
    if (Object.entries(identity).some(([key, value]) => report.identity?.[key] !== value)) {
      throw new Error("Shard identity differs from the current run")
    }
    const selected = pathsInShard(files, shard)
    if (results.length !== selected.length || new Set(results.map(result => result.file)).size !== selected.length) {
      throw new Error("Missing or duplicate spec result")
    }
    for (const result of results) {
      if (!selected.includes(result.file) || !result.passed || !result.cases.length) {
        throw new Error("Spec failed or ran outside its assigned shard: " + result.file)
      }
      for (const test of result.cases) {
        if (expectedCases.get(test.id) !== result.file || test.file !== result.file || observedCases.has(test.id) ||
            !["expected", "skipped"].includes(test.outcome) || (test.outcome === "expected" && !test.attempts.length)) {
          throw new Error("Unexpected, failed or repeated test: " + test.file + " " + test.title)
        }
        observedCases.set(test.id, test)
      }
    }
  }
  if (observedCases.size !== expectedCases.size) throw new Error("Missing test results")
  return [...observedCases.values()].sort((left, right) => left.id.localeCompare(right.id))
}
