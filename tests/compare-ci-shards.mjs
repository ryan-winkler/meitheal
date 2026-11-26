import { readFileSync } from "node:fs"
import { join } from "node:path"
import { isDeepStrictEqual } from "node:util"
import istanbulCoverage from "istanbul-lib-coverage"

const [controlDir, parallelDir] = process.argv.slice(2)
if (!controlDir || !parallelDir) {
  throw new Error("Usage: node tests/compare-ci-shards.mjs CONTROL_DIRECTORY PARALLEL_DIRECTORY")
}

const json = (directory, file) => JSON.parse(readFileSync(join(directory, file), "utf8"))
const compare = (name, left, right) => {
  if (!isDeepStrictEqual(left, right)) throw new Error(name + " differs between control and shards")
}
compare("Test identities and outcomes", json(controlDir, "cases.json"), json(parallelDir, "cases.json"))

function coverage(directory) {
  const map = istanbulCoverage.createCoverageMap(json(directory, "lcov.info.json"))
  return [...map.files()].sort().map(file => {
    const report = map.fileCoverageFor(file)
    const { branchMap, b } = report.toJSON()
    const lines = Object.entries(report.getLineCoverage()).map(([line, hits]) => [line, hits > 0])
    const branches = Object.entries(branchMap).map(([id, branch]) => {
      return JSON.stringify([branch.type, branch.loc, branch.locations, b[id].map(hits => hits > 0)])
    }).sort()
    return { file, lines, branches }
  })
}

const control = coverage(controlDir)
const parallel = coverage(parallelDir)
compare("Covered source paths", control.map(file => file.file), parallel.map(file => file.file))
const differences = control.flatMap((entry, index) => {
  return isDeepStrictEqual(entry, parallel[index]) ? [] : [entry.file]
})
if (differences.length) throw new Error("Coverage locations or outcomes differ: " + differences.join(", "))
console.log("Control and shards agree on test outcomes and mapped line and branch coverage.")
