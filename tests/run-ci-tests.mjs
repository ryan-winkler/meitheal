import { execFileSync, spawn } from "node:child_process"
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { generateCoverageMap, generateLcovCoverage } from "./coverage-report.mjs"
import { artifactDigest, parseShard, pathsInShard, shardIdentity, testedTree, testsInReport } from "./ci-shards.mjs"

const cwd = fileURLToPath(new URL(".", import.meta.url))
const repoRoot = resolve(cwd, "..")
const cli = join(cwd, "node_modules/@playwright/test/cli.js")
const env = { ...process.env, MEITHEAL_TEST_BROWSER: "1" }
const coverageOutput = env.MEITHEAL_COVERAGE_FILE
  ? resolve(repoRoot, env.MEITHEAL_COVERAGE_FILE)
  : null
const evidenceDir = env.MEITHEAL_CI_EVIDENCE_DIR ? resolve(repoRoot, env.MEITHEAL_CI_EVIDENCE_DIR) : null
const traceDir = env.MEITHEAL_CI_LOCAL_TRACE_DIR ? resolve(repoRoot, env.MEITHEAL_CI_LOCAL_TRACE_DIR) : null
if (env.MEITHEAL_CI_SHARD && !evidenceDir) throw new Error("A shard requires an evidence directory")
const args = process.argv.slice(2)
const exactSpec = args[0] === "--spec" ? args[1] : undefined
if (args.length && (!exactSpec || args.length !== 2 || env.MEITHEAL_CI_SHARD || evidenceDir)) {
  throw new Error("Use test:ci --spec SPEC_PATH to replay one discovered spec")
}
const port = Number(env.MEITHEAL_TEST_PORT ?? 4611)
if (!Number.isInteger(port) || port < 1024 || port > 65534) {
  throw new Error("MEITHEAL_TEST_PORT must allow two consecutive unprivileged ports")
}

const listing = execFileSync(process.execPath, [cli, "test", "--list", "--reporter=json"], {
  cwd, env, encoding: "utf8", maxBuffer: 16 * 1024 * 1024,
})
const allFiles = [...new Set(JSON.parse(listing).suites.map(suite => suite.file))]
if (!allFiles.length || allFiles.some(file => typeof file !== "string" || !file.length)) {
  throw new Error("Playwright did not list any valid test files")
}

if (exactSpec && !allFiles.includes(exactSpec)) throw new Error("Spec not found: " + exactSpec)
const shard = parseShard(env.MEITHEAL_CI_SHARD ?? "1/1", allFiles.length)
const files = exactSpec ? [exactSpec] : pathsInShard(allFiles, shard)
const results = []
if (evidenceDir) await mkdir(evidenceDir, { recursive: true })
const output = await mkdtemp(join(tmpdir(), "meitheal-ci-"))
const v8CoverageDir = coverageOutput || evidenceDir ? join(output, "v8-coverage") : null
if (v8CoverageDir) await mkdir(v8CoverageDir, { recursive: true })
const children = new Set()
const stop = signal => {
  process.exitCode = signal === "SIGINT" ? 130 : 143
  for (const child of children) child.kill(signal)
}
process.once("SIGINT", stop)
process.once("SIGTERM", stop)

async function runFile(file, fixturePort, index) {
  const specDir = join(output, String(index))
  await mkdir(specDir)
  const reportPath = join(specDir, "playwright.json")
  const started = Date.now()
  const pattern = file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$"
  const passed = await new Promise(resolve => {
    const child = spawn(process.execPath, [
      cli, "test", "--output", join(specDir, "results"), evidenceDir ? "--reporter=list,json" : "--reporter=list",
      ...(traceDir ? ["--trace", "retain-on-first-failure"] : []),
      pattern,
    ], {
      cwd,
      env: {
        ...env,
        MEITHEAL_TEST_PORT: String(fixturePort),
        TMPDIR: specDir,
        ...(evidenceDir ? { PLAYWRIGHT_JSON_OUTPUT_FILE: reportPath } : {}),
        ...(v8CoverageDir ? { NODE_V8_COVERAGE: v8CoverageDir } : {}),
      },
      stdio: "inherit",
    })
    children.add(child)
    child.once("error", error => {
      console.error(file, error.message)
    })
    child.once("close", code => {
      children.delete(child)
      resolve(code === 0)
    })
  })
  let cases = []
  if (evidenceDir) {
    try {
      cases = testsInReport(JSON.parse(await readFile(reportPath, "utf8")))
    } catch (error) {
      console.error("Playwright result unavailable:", file, error.code ?? error.name)
    }
    results.push({ file, passed, durationMs: Date.now() - started, cases })
  }
  if (!passed) {
    console.error("Replay: pnpm --filter @meitheal/tests test:ci --spec", file)
    for (const test of cases.filter(test => test.outcome === "unexpected")) {
      console.error("Failed:", test.file, test.line ?? "", test.title)
    }
    if (traceDir) {
      await mkdir(traceDir, { recursive: true })
      await cp(join(specDir, "results"), join(traceDir, file), { recursive: true }).catch(error => {
        if (error.code !== "ENOENT") throw error
      })
    }
  }
  return passed && (!evidenceDir || cases.length > 0)
}

let next = 0
let passed = 0
const failures = []
async function runLane(fixturePort) {
  while (!process.exitCode && next < files.length) {
    const index = next++
    const file = files[index]
    console.log(`[CI ${index + 1}/${files.length}] ${file}`)
    if (await runFile(file, fixturePort, index)) passed++
    else failures.push(file)
  }
}

try {
  await Promise.all([runLane(port), runLane(port + 1)])
  console.log(`CI specs: ${passed} passed, ${failures.length} failed, ${files.length - next} not run`)
  if (evidenceDir) {
    const identity = shardIdentity(testedTree(repoRoot))
    const mapFile = join(evidenceDir, "coverage.json")
    let coverageDigest
    try {
      if (v8CoverageDir && !process.exitCode && !failures.length) {
        await generateCoverageMap(v8CoverageDir, mapFile, repoRoot)
        coverageDigest = artifactDigest(mapFile)
      }
    } finally {
      await writeFile(join(evidenceDir, "result.json"), JSON.stringify({ identity, shard, results, coverageDigest }))
    }
  }
  if (v8CoverageDir && coverageOutput && !process.exitCode && !failures.length) {
    const summary = await generateLcovCoverage(v8CoverageDir, coverageOutput, repoRoot)
    // Name the variable rather than echoing its value: nothing read from the
    // environment reaches the CI log.
    const { coveredFiles, linesPct, branchesPct } = summary
    console.log(
      `Coverage LCOV written to $MEITHEAL_COVERAGE_FILE (${coveredFiles} files, ${linesPct}% lines, ${branchesPct}% branches)`,
    )
  }
  if (failures.length) console.error(failures.join("\n"))
  if (failures.length && !process.exitCode) process.exitCode = 1
} finally {
  await rm(output, { recursive: true, force: true })
}
