import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { expect, test } from "@playwright/test"

import { convertCodacyJsonToSarif } from "../../scripts/codacy-json-to-sarif.mjs"

test("convertCodacyJsonToSarif translates Issues, maps severities, and handles non-UTF8 files safely", () => {
  const work = mkdtempSync(join(tmpdir(), "meitheal-codacy-sarif-"))
  try {
    writeFileSync(join(work, "good.ts"), "export const answer = 42 // — utf8\n", "utf8")
    writeFileSync(join(work, "binary.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xc3, 0x28]))

    const sarif = convertCodacyJsonToSarif(
      [
        {
          Issue: {
            patternId: { value: "semgrep_rule" },
            filename: "good.ts",
            message: { text: "Security pattern matched" },
            level: "Err",
            category: "Security",
            location: { FullLocation: { line: 1, column: 8 } },
          },
        },
        {
          Issue: {
            patternId: { value: "style_rule" },
            filename: "binary.png",
            message: { text: "Non-security finding on binary bytes" },
            level: "Warn",
            category: "CodeStyle",
            location: { LineLocation: { line: 0 } },
          },
        },
        { FileMetrics: { filename: "good.ts", lineComplexities: [] } },
      ],
      work,
    )

    expect(sarif.version).toBe("2.1.0")
    expect(sarif.runs[0]?.results).toHaveLength(2)

    const [first, second] = sarif.runs[0]!.results
    expect(first?.ruleId).toBe("semgrep_rule")
    expect(first?.level).toBe("error")
    expect(first?.locations[0]?.physicalLocation.region).toEqual({ startLine: 1, startColumn: 8 })
    expect(first?.partialFingerprints.primaryLocationLineHash).toMatch(/^[a-f0-9]{16}:1$/)

    expect(second?.ruleId).toBe("style_rule")
    expect(second?.level).toBe("note")
    expect(second?.locations[0]?.physicalLocation.region).toEqual({ startLine: 1 })
    expect(second?.partialFingerprints.primaryLocationLineHash).toMatch(/^[a-f0-9]{16}:1$/)
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
})

test("convertCodacyJsonToSarif returns valid empty SARIF when zero issues are reported", () => {
  const sarif = convertCodacyJsonToSarif([], process.cwd())
  expect(sarif.version).toBe("2.1.0")
  expect(sarif.runs[0]?.results).toEqual([])
  expect(sarif.runs[0]?.artifacts).toEqual([])
  expect(sarif.runs[0]?.tool.driver.rules).toEqual([])
})
