import { execFileSync, spawn } from "node:child_process"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { generateLcovCoverage } from "./coverage-report.mjs"

const cwd = fileURLToPath(new URL(".", import.meta.url))
const repoRoot = resolve(cwd, "..")
const cli = join(cwd, "node_modules/@playwright/test/cli.js")
const env = { ...process.env, MEITHEAL_TEST_BROWSER: "1" }
const coverageOutput = env.MEITHEAL_COVERAGE_FILE
  ? resolve(repoRoot, env.MEITHEAL_COVERAGE_FILE)
  : null
const port = Number(env.MEITHEAL_TEST_PORT ?? 4611)
if (!Number.isInteger(port) || port < 1024 || port > 65534) {
  throw new Error("MEITHEAL_TEST_PORT must allow two consecutive unprivileged ports")
}

const listing = execFileSync(process.execPath, [cli, "test", "--list", "--reporter=json"], {
  cwd, env, encoding: "utf8", maxBuffer: 16 * 1024 * 1024,
})
const files = [...new Set(JSON.parse(listing).suites.map(suite => suite.file))]
if (!files.length || files.some(file => typeof file !== "string" || !file.length)) {
  throw new Error("Playwright did not list any valid test files")
}

const output = await mkdtemp(join(tmpdir(), "meitheal-ci-"))
const v8CoverageDir = coverageOutput ? join(output, "v8-coverage") : null
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
  const pattern = file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$"
  return new Promise(resolve => {
    const child = spawn(process.execPath, [
      cli, "test", "--output", join(specDir, "results"), "--reporter=list", pattern,
    ], {
      cwd,
      env: {
        ...env,
        MEITHEAL_TEST_PORT: String(fixturePort),
        TMPDIR: specDir,
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
