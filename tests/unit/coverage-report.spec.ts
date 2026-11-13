import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"

import { expect, test } from "@playwright/test"

import { generateLcovCoverage, normalizeCoveredSourcePath } from "../coverage-report.mjs"

const repoRoot = resolve(process.cwd(), "..")

test("normalizeCoveredSourcePath accepts repo source files and rejects tests or artifacts", () => {
  expect(normalizeCoveredSourcePath(join(repoRoot, "packages/domain-tasks/src/index.ts"), repoRoot)).toBe(
    "packages/domain-tasks/src/index.ts",
  )
  expect(normalizeCoveredSourcePath(join(repoRoot, "apps/web/src/lib/api-response.ts"), repoRoot)).toBe(
    "apps/web/src/lib/api-response.ts",
  )
  expect(normalizeCoveredSourcePath(join(repoRoot, "tests/unit/coverage-report.spec.ts"), repoRoot)).toBeNull()
  expect(normalizeCoveredSourcePath(join(repoRoot, "apps/web/src/env.d.ts"), repoRoot)).toBeNull()
  expect(normalizeCoveredSourcePath(join(repoRoot, "apps/web/dist/server/entry.mjs"), repoRoot)).toBeNull()
  expect(normalizeCoveredSourcePath("/tmp/dist/repo/packages/domain-tasks/src/index.ts", "/tmp/dist/repo")).toBe(
    "packages/domain-tasks/src/index.ts",
  )
  expect(normalizeCoveredSourcePath("/tmp/outside.ts", repoRoot)).toBeNull()
})

test("generateLcovCoverage merges V8 JSON dumps into repo-relative LCOV records", async () => {
  const work = mkdtempSync(join(tmpdir(), "meitheal-cov-spec-"))
  try {
    const targetFile = join(repoRoot, "packages/domain-tasks/src/task-status-values.mjs")
    const targetUrl = pathToFileURL(targetFile).href
    const sourceText = readFileSync(targetFile, "utf8")

    const makeDump = (hitCount: number) => ({
      result: [
        {
          scriptId: "1",
          url: targetUrl,
          functions: [
            {
              functionName: "",
              ranges: [{ startOffset: 0, endOffset: sourceText.length, count: hitCount }],
              isBlockCoverage: true,
            },
          ],
        },
        {
          scriptId: "2",
          url: pathToFileURL(join(repoRoot, "tests/unit/coverage-report.spec.ts")).href,
          functions: [],
        },
      ],
    })

    writeFileSync(join(work, "coverage-1.json"), JSON.stringify(makeDump(1)))
    writeFileSync(join(work, "coverage-2.json"), JSON.stringify(makeDump(2)))

    const lcovOut = join(work, "nested/lcov.info")
    const summary = await generateLcovCoverage(work, lcovOut, repoRoot)

    expect(summary.coveredFiles).toBe(1)
    expect(summary.linesPct).toBe(100)

    const lcov = readFileSync(lcovOut, "utf8")
    expect(lcov).toContain("SF:packages/domain-tasks/src/task-status-values.mjs")
    expect(lcov).not.toContain("tests/unit/coverage-report.spec.ts")
    expect(lcov).toContain("end_of_record")
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
})

test("generateLcovCoverage maps transpiled TypeScript via lineLengths without source property", async () => {
  const work = mkdtempSync(join(tmpdir(), "meitheal-cov-ts-"))
  try {
    const targetFile = join(repoRoot, "packages/domain-auth/src/agent-route-policy.ts")
    const targetUrl = pathToFileURL(targetFile).href
    // Minimal V3 sourcemap mapping transpiled line 39 to original TS line 39 (delta +38 lines = VLQ `sC`).
    const sourceMapData = {
      version: 3,
      sources: [targetUrl],
      names: [],
      mappings: `${";".repeat(38)}AAsCA`,
    }
    const lineLengths = Array.from({ length: 45 }, () => 12)
    lineLengths[38] = 40
    const offsetLine39 = lineLengths.slice(0, 38).reduce((acc, len) => acc + len + 1, 0)

    const dump = {
      result: [
        {
          scriptId: "1",
          url: targetUrl,
          functions: [
            {
              functionName: "isTaskReactionRoute",
              ranges: [{ startOffset: offsetLine39, endOffset: offsetLine39 + 40, count: 3 }],
              isBlockCoverage: true,
            },
          ],
        },
      ],
      "source-map-cache": {
        [targetUrl]: {
          lineLengths,
          data: sourceMapData,
          url: targetUrl,
        },
      },
    }

    writeFileSync(join(work, "coverage-ts.json"), JSON.stringify(dump))
    const lcovOut = join(work, "lcov.info")
    const summary = await generateLcovCoverage(work, lcovOut, repoRoot)

    expect(summary.coveredFiles).toBe(1)
    const lcov = readFileSync(lcovOut, "utf8")
    expect(lcov).toContain("SF:packages/domain-auth/src/agent-route-policy.ts")
    expect(lcov).toContain("FN:39,isTaskReactionRoute")
    expect(lcov).toContain("FNDA:3,isTaskReactionRoute")
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
})
