import { expect, test } from "@playwright/test"
import { parseShard, planShards, testInventory, testsInReport, validateShardReports } from "../ci-shards.mjs"

const files = ["a.spec.ts", "b.spec.ts", "c.spec.ts"]
const cases = files.map(file => ({ id: file, file, title: file, outcome: "expected", attempts: ["passed"] }))
const inventory = cases.map(test => ({ ...test, suiteFile: test.file }))
const identity = { tree: "tree", run: "24", attempt: "1" }

function report(index: number, timings?: Record<string, number>) {
  const shard = { index, count: 2 }
  return {
    identity: { ...identity },
    shard,
    results: planShards(files, shard.count, timings)[index - 1]!.map(file => ({
      file, passed: true, cases: cases.filter(candidate => candidate.file === file),
    })),
  }
}

test("shards select complete and disjoint spec groups", () => {
  expect(parseShard("1/2", files.length)).toEqual({ index: 1, count: 2 })
  expect(planShards(files, 2)).toEqual([["a.spec.ts", "c.spec.ts"], ["b.spec.ts"]])
  expect(() => parseShard("2/1", files.length)).toThrow()
  expect(() => parseShard("1/10", files.length)).toThrow()
  expect(() => parseShard("0/2", files.length)).toThrow()
  expect(validateShardReports([report(2), report(1)], files, inventory, 2, identity)).toEqual(cases)
})

test("the duration plan places longer specs first and covers new specs in stable order", () => {
  const paths = [...files, "d.spec.ts", "e.spec.ts"]
  const timings = { "a.spec.ts": 48_000, "b.spec.ts": 25_000, "c.spec.ts": 25_000, "d.spec.ts": 0 }
  const expected = [["a.spec.ts", "d.spec.ts"], ["b.spec.ts", "c.spec.ts", "e.spec.ts"]]
  expect(planShards(paths, 2, timings)).toEqual(expected)
  expect(planShards([...paths].reverse(), 2, timings)).toEqual(expected)
  expect(planShards([...paths].reverse(), 1, timings)).toEqual([[...paths].reverse()])
})

test("aggregation verifies results against the same duration plan", () => {
  const timings = { "b.spec.ts": 60_000, "c.spec.ts": 60_000 }
  expect(validateShardReports([report(1, timings), report(2, timings)], files, inventory, 2, identity, timings)).toEqual(cases)
  expect(() => validateShardReports([report(1), report(2)], files, inventory, 2, identity, timings)).toThrow(/assigned shard/)
})

test("imported tests belong to their runnable suite and retain their declaration path", () => {
  const suites = files.slice(0, 2)
  const declaration = "scripts/shared-fixture.ts"
  const listed = {
    suites: suites.map(file => ({
      file,
      suites: [{
        specs: [{
          id: file,
          file: declaration,
          title: "validates the shared behavior",
          tests: [{ projectId: "", status: "expected", results: [{ status: "passed" }] }],
        }],
      }],
    })),
  }
  const discovered = testInventory(listed)
  const observed = testsInReport(listed)
  const results = suites.map((file, index) => ({ file, passed: true, cases: [observed[index]!] }))
  const shard = { index: 1, count: 1 }
  expect(validateShardReports([{ identity, shard, results }], suites, discovered, 1, identity)).toEqual(observed)

  const swapped = [
    { ...results[0]!, cases: results[1]!.cases },
    { ...results[1]!, cases: results[0]!.cases },
  ]
  expect(() => validateShardReports([{ identity, shard, results: swapped }], suites, discovered, 1, identity)).toThrow(/Unexpected/)
  const wrongDeclaration = [
    { ...results[0]!, cases: [{ ...observed[0]!, file: suites[0]! }] },
    results[1]!,
  ]
  expect(() => validateShardReports([{ identity, shard, results: wrongDeclaration }], suites, discovered, 1, identity)).toThrow(/Unexpected/)
})

test("aggregation rejects missing, duplicate and stale shards", () => {
  expect(() => validateShardReports([report(1)], files, inventory, 2, identity)).toThrow(/number of shard/)
  expect(() => validateShardReports([report(1), report(1)], files, inventory, 2, identity)).toThrow(/duplicate shard/)
  const stale = report(2)
  stale.identity.attempt = "2"
  expect(() => validateShardReports([report(1), stale], files, inventory, 2, identity)).toThrow(/identity/)
})

test("aggregation rejects a failed spec or incomplete test report", () => {
  const failed = report(1)
  failed.results[0]!.passed = false
  expect(() => validateShardReports([failed, report(2)], files, inventory, 2, identity)).toThrow(/Spec failed/)
  const empty = report(1)
  empty.results[0]!.cases = []
  expect(() => validateShardReports([empty, report(2)], files, inventory, 2, identity)).toThrow(/Spec failed/)
  const different = report(1)
  different.results[0]!.cases = [{ ...cases[0]!, id: "another" }]
  expect(() => validateShardReports([different, report(2)], files, inventory, 2, identity)).toThrow(/Unexpected/)
})
