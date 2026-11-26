import { expect, test } from "@playwright/test"
import { parseShard, pathsInShard, validateShardReports } from "../ci-shards.mjs"

const files = ["a.spec.ts", "b.spec.ts", "c.spec.ts"]
const cases = files.map(file => ({ id: file, file, title: file, outcome: "expected", attempts: ["passed"] }))
const identity = { tree: "tree", run: "24", attempt: "1" }

function report(index: number) {
  const shard = { index, count: 2 }
  return {
    identity: { ...identity },
    shard,
    results: pathsInShard(files, shard).map(file => ({
      file, passed: true, cases: cases.filter(candidate => candidate.file === file),
    })),
  }
}

test("shards select complete and disjoint spec groups", () => {
  expect(pathsInShard(files, parseShard("1/2", files.length))).toEqual(["a.spec.ts", "c.spec.ts"])
  expect(pathsInShard(files, parseShard("2/2", files.length))).toEqual(["b.spec.ts"])
  expect(() => parseShard("2/1", files.length)).toThrow()
  expect(() => parseShard("1/10", files.length)).toThrow()
  expect(() => parseShard("0/2", files.length)).toThrow()
  expect(validateShardReports([report(2), report(1)], files, cases, 2, identity)).toEqual(cases)
})

test("aggregation rejects missing, duplicate and stale shards", () => {
  expect(() => validateShardReports([report(1)], files, cases, 2, identity)).toThrow(/number of shard/)
  expect(() => validateShardReports([report(1), report(1)], files, cases, 2, identity)).toThrow(/duplicate shard/)
  const stale = report(2)
  stale.identity.attempt = "2"
  expect(() => validateShardReports([report(1), stale], files, cases, 2, identity)).toThrow(/identity/)
})

test("aggregation rejects a failed spec or incomplete test report", () => {
  const failed = report(1)
  failed.results[0]!.passed = false
  expect(() => validateShardReports([failed, report(2)], files, cases, 2, identity)).toThrow(/Spec failed/)
  const empty = report(1)
  empty.results[0]!.cases = []
  expect(() => validateShardReports([empty, report(2)], files, cases, 2, identity)).toThrow(/Spec failed/)
  const different = report(1)
  different.results[0]!.cases = [{ ...cases[0]!, id: "another" }]
  expect(() => validateShardReports([different, report(2)], files, cases, 2, identity)).toThrow(/Unexpected/)
})
