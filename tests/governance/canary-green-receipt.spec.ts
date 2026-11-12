import { createHash } from "node:crypto"
import { spawnSync, type SpawnSyncReturns } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { delimiter, dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { expect, test as base } from "@playwright/test"

const root = fileURLToPath(new URL("../..", import.meta.url)).replace(/\/$/, "")
const revision = "abcdef1234567890abcdef1234567890abcdef12"
const version = revision.slice(0, 12)
const arm = `sha256:${"a".repeat(64)}`
const amd = `sha256:${"b".repeat(64)}`
const digest = `sha256:${"c".repeat(64)}`
const profile = "green-2000-task-v2"
const hash = "d060f566d2ab6c8a90537b21f049cc1215b97ea9328e23e428b56aa1246fa50b"
const parentHash = "60b394f364c7f43a0038c0fb4376abd1a435a1760cf2bcd7ca29404e12ea6869"
const clock = "driver_clock,v1,uptime_start_cs=1000000,uptime_end_cs=1030850,user_start_usec=5000000,system_start_usec=7000000,user_end_usec=16000000,system_end_usec=19000000"
const driverCgroup = "driver_cgroup_receipt,v1,workload_status=0,receipt_status=0,memory.max=83886080,memory.swap.max=0,memory.swap.current=0,cpu.max=100000 100000,max=0,oom=0,oom_kill=0,oom_group_kill=0"
// The 309-second counter window is slightly longer than the driver's timer.
const timing = "driver_seconds,308.500,11.000,12.000"

function passingReceipt() {
  const installed = `${amd} healthy 0 2026-01-01T00:00:00Z ${"d".repeat(64)}`
  const routes = ["today,200", "list,200", "search,200", "open,200", "create,201", "complete,200", "readback,200"]
  return [
    `benchmark_profile=${profile}`,
    `driver_parent_script_sha256=${parentHash}`,
    `${parentHash}  /tmp/fixture/green-canary-driver-parent.sh`,
    `image=${arm} architecture=arm64 bytes=123`,
    `helper_image=sha256:5ce98efbe0fdb68edf92f3b98dfe78a70739a412d76083a42bfefbde8410824f architecture=arm64 layer=sha256:5070b31eb4c50bf7d0297a1a5aee25bc13ff29894e87354610f6b8b6a445e07e`,
    `${hash}  /tmp/fixture/seed-and-run.sh`,
    `seed_and_driver_script_sha256=${hash}`,
    `{"status":"ok","service":"meitheal-web","version":"${version}"}`,
    `installed_canary_before=${installed}`,
    "limits,201326592,0,100000 100000",
    '{"synthetic_tasks":2000}',
    "seed=separate_cgroup,same_loopback_namespace,disposable_data_volume,fixed_helper",
    "cgroup_fields,phase,epoch,memory_current,swap,cpu_usec,max,oom,oom_kill",
    "driver=separate_cgroup,same_loopback_namespace,fixed_helper",
    ...Array.from({ length: 71 }, (_, index) => {
      const elapsed = index * 5 + Math.floor(index / 3)
      return `cgroup,${index < 12 ? "idle" : "active"},${1800000000 + elapsed},${index < 12 ? 134217727 : 167772159},0,${elapsed * 150000},0,0,0`
    }),
    ...Array.from({ length: 105 }, () => routes.map(route => `http,${route},0.020000`)).flat(),
    "workload,completed,105",
    clock,
    timing,
    driverCgroup,
    "max 0", "oom 0", "oom_kill 0",
    "probe_state=running health=healthy oom=false restarts=0",
    `installed_canary_after=${installed}`,
    "probe_cleanup=complete",
  ].join("\n")
}

const mockCommand = `
import { appendFileSync, readFileSync, writeFileSync } from "node:fs"
const [tool, ...args] = process.argv.slice(2)
const root = process.env.FIXTURE_ROOT
const revision = process.env.FIXTURE_REVISION
const app = process.env.FIXTURE_APP
if (tool === "git") {
  if (args[0] === "-C") args.splice(0, 2)
  if (args[0] === "status") process.exit(0)
  if (args[0] === "symbolic-ref") {
    const branch = process.env.FIXTURE_BRANCH
    if (branch === "__detached__") process.exit(1)
    console.log(branch || "dev")
    process.exit(0)
  }
  if (args[0] !== "rev-parse") process.exit(98)
  console.log(args[1] === "HEAD" ? revision : (process.argv.includes("-C") ? app : root))
  process.exit(0)
}
if (tool === "gh") {
  const refArg = args.find(arg => arg.includes("/git/ref/heads/")) || ""
  appendFileSync(process.env.FIXTURE_TRACE, (refArg.endsWith("/heads/dev") ? "dev" : "main") + "\\n")
  console.log(process.env.FIXTURE_MAIN || revision)
  process.exit(0)
}
const store = args[0] === "--root" ? args[1] : ""
if (store) args.splice(0, 5)
const command = args[0]
const target = args.at(-1)
const option = name => args[args.indexOf(name) + 1]
const arch = target.includes("-aarch64:") || target === process.env.FIXTURE_ARM.slice(7) ? "aarch64" : "amd64"
const id = arch === "aarch64" ? process.env.FIXTURE_ARM : process.env.FIXTURE_AMD
const digest = process.env.FIXTURE_DIGEST
appendFileSync(process.env.FIXTURE_TRACE, command + "\\n")
if (command === "image" && args.includes("--format")) {
  console.log(target.replace(/:[^:]+$/, "") + "@" + (process.env.FIXTURE_PUBLIC_DIGEST || digest))
} else if (command === "image") {
  console.log(JSON.stringify([{ Os: "linux", Architecture: arch === "aarch64" ? "arm64" : "amd64", Id: id,
    Config: { Labels: { "org.opencontainers.image.licenses": "LicenseRef-Proprietary", "org.opencontainers.image.revision": arch === "aarch64" && process.env.FIXTURE_ARM_REVISION || revision,
      "io.hass.version": revision.slice(0, 12), "io.hass.arch": arch, "io.hass.type": "addon" } } }]))
} else if (command === "run") {
  if (!args.includes("--pull=never") || option("--network") !== "none") process.exit(98)
  console.log("fixture-container")
} else if (command === "login") {
  if (readFileSync(0, "utf8").trim() !== "fixture-token") process.exit(98)
  writeFileSync(option("--authfile"), '{"auths":{"fixture":{}}}')
} else if (command === "manifest") {
  if (!store.endsWith("/publisher/storage")) process.exit(98)
  if (process.env.FIXTURE_EXISTING_ID) process.exit(0)
  console.error("fixture: " + (process.env.FIXTURE_MANIFEST_ERROR || "manifest unknown"))
  process.exit(1)
} else if (command === "push") {
  writeFileSync(option("--digestfile"), digest + "\\n")
} else if (command === "pull") {
  if (store.endsWith("/publisher/storage")) {
    if (!process.env.FIXTURE_EXISTING_ID || !args.includes("--quiet")) process.exit(98)
    console.log(process.env.FIXTURE_EXISTING_ID.slice(7))
  } else if (!store.endsWith("/public/storage") || option("--policy") !== "always" || !args.includes("--tls-verify=true") ||
    readFileSync(option("--authfile"), "utf8").trim() !== '{"auths":{}}' ||
    process.env.DOCKER_CONFIG !== process.env.XDG_CONFIG_HOME) process.exit(98)
} else if (!["exec", "rm"].includes(command)) {
  process.exit(98)
}
`

type Harness = {
  run: (args: string[], env?: Record<string, string>) => SpawnSyncReturns<string>
  receipt: string
  trace: string
  app: string
}

const test = base.extend<{ harness: Harness }>({
  harness: async ({}, use) => {
    const fixture = mkdtempSync(join(tmpdir(), "meitheal-canary-receipt-"))
    try {
      const receipt = join(fixture, "green.log")
      const trace = join(fixture, "trace")
      const app = join(fixture, "app")
      const bin = join(fixture, "bin")
      const mock = join(fixture, "mock.mjs")
      mkdirSync(bin)
      mkdirSync(join(app, ".git"), { recursive: true })
      writeFileSync(receipt, passingReceipt())
      writeFileSync(mock, mockCommand)
      for (const tool of ["git", "gh", "podman"]) {
        writeFileSync(join(bin, tool), `#!/bin/bash\nexec "$FIXTURE_NODE" "$FIXTURE_MOCK" ${tool} "$@"\n`, { mode: 0o755 })
      }
      const run: Harness["run"] = (args, env) => {
        writeFileSync(trace, "")
        return spawnSync("bash", ["scripts/publish-canary-local.sh", ...args], {
          cwd: root,
          input: "fixture-token\n",
          encoding: "utf8",
          env: {
            HOME: fixture,
            PATH: [bin, dirname(process.execPath), process.env.PATH].join(delimiter),
            FIXTURE_NODE: process.execPath,
            FIXTURE_MOCK: mock,
            FIXTURE_TRACE: trace,
            FIXTURE_ROOT: root,
            FIXTURE_APP: app,
            FIXTURE_REVISION: revision,
            FIXTURE_ARM: arm,
            FIXTURE_AMD: amd,
            FIXTURE_DIGEST: digest,
            ...env,
          },
        })
      }
      await use({ run, receipt, trace, app })
    } finally {
      rmSync(fixture, { recursive: true, force: true })
    }
  },
})

function publish(arch: "aarch64" | "amd64", image: string, receipt: string) {
  return ["publish", arch, image, "fixture-publisher", arm, receipt]
}

function stage(harness: Harness) {
  return ["stage", digest, amd, digest, arm, harness.app, harness.receipt]
}

test("missing and malformed Green receipts fail before any registry action", ({ harness }) => {
  const args = publish("aarch64", arm, harness.receipt)
  expect(harness.run(args.slice(0, -1)).stderr).toContain("Usage:")
  expect(harness.run(publish("aarch64", arm, harness.receipt + ".missing")).stderr).toContain("readable raw Green receipt")
  writeFileSync(harness.receipt, '{"checks":{"idle below 128 MiB":true}}')
  expect(harness.run(args).stderr).toContain("Green receipt rejected")
  expect(harness.run(stage(harness)).stderr).toContain("Green receipt rejected")
  expect(readFileSync(harness.trace, "utf8")).toBe("")
})

test("receipt metrics and exact ARM64 config must pass before registry action", ({ harness }) => {
  writeFileSync(harness.receipt, passingReceipt().replace(`image=${arm}`, `image=${amd}`))
  expect(harness.run(publish("aarch64", arm, harness.receipt)).stderr).toContain("exact ARM64 config ID")
  expect(readFileSync(harness.trace, "utf8")).toBe("")

  let listRequests = 0
  writeFileSync(harness.receipt, passingReceipt().replaceAll(",134217727,", ",134217728,")
    .replaceAll(",167772159,", ",167772160,")
    .replaceAll("list,200,0.020000", line => listRequests++ < 6 ? "list,200,0.350001" : line))
  const result = harness.run(publish("aarch64", arm, harness.receipt))
  expect(result.status).toBe(1)
  expect(result.stderr).toContain("idle below 128 MiB, active below 160 MiB, each route p95 at or below 350 ms")
  expect(readFileSync(harness.trace, "utf8")).toBe("")
})

test("the Green report exposes tail samples without changing the gate", ({ harness }) => {
  const report = () => spawnSync("python3", ["scripts/verify-canary-green.py", "--report", harness.receipt, arm, version], {
    cwd: root,
    encoding: "utf8",
  })
  const withListOutliers = (count: number) => {
    let listRequests = 0
    return passingReceipt().replaceAll("list,200,0.020000", line => listRequests++ < count ? "list,200,0.800000" : line)
  }

  writeFileSync(harness.receipt, withListOutliers(5))
  const passing = report()
  expect(passing.status, passing.stderr).toBe(0)
  const metrics = JSON.parse(passing.stdout)
  expect(metrics.memory_current_bytes.idle).toMatchObject({ samples: 12, p95_rank: 12, p95: 134217727, max: 134217727 })
  expect(metrics.active_cpu_percent_of_one_core).toMatchObject({ mean: 15, intervals: { p95: 15 }, throttle_count_delta: null })
  expect(metrics.loopback_full_response_ms.routes.list).toEqual({
    samples: 105, p50: 20, p95: 20, p95_rank: 100, max: 800, over_limit: 5,
  })

  writeFileSync(harness.receipt, withListOutliers(6))
  const failing = report()
  expect(failing.status).toBe(1)
  expect(failing.stderr).toContain("each route p95 at or below 350 ms")
  const failedMetrics = JSON.parse(failing.stdout)
  expect(failedMetrics.checks["each route p95 at or below 350 ms"]).toBe(false)
  expect(failedMetrics.loopback_full_response_ms.routes.list).toMatchObject({ p95: 800, over_limit: 6 })
})

test("driver timing must be unique, valid and consistent with the request and sample windows", ({ harness }) => {
  const args = publish("aarch64", arm, harness.receipt)
  for (const [record, failure] of [
    ["", "one valid driver_seconds"],
    ["driver_seconds,311.000,11.000,NaN", "one valid driver_seconds"],
    ["driver_seconds,308.500,11.:00,12.000", "one valid driver_seconds"],
    [`${timing}\n${timing}`, "one valid driver_seconds"],
    ["driver_seconds,262.499,11.000,12.000", "outside the fixed workload bounds"],
    ["driver_seconds,360.001,11.000,12.000", "outside the fixed workload bounds"],
    ["driver_seconds,345.000,11.000,12.000", "timing does not match monotonic uptime"],
  ] as const) {
    writeFileSync(harness.receipt, passingReceipt().replace(timing, record))
    const result = harness.run(args)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain(failure)
    expect(readFileSync(harness.trace, "utf8")).toBe("")
  }
  writeFileSync(harness.receipt, passingReceipt().replaceAll(",0.020000", ",0.350000"))
  expect(harness.run(args).stderr).toContain("wall time cannot contain the recorded requests and sleeps")
  expect(readFileSync(harness.trace, "utf8")).toBe("")
})

test("a final timestamp jump cannot dilute a failing CPU measurement", ({ harness }) => {
  const args = publish("aarch64", arm, harness.receipt)
  const busy = passingReceipt().split("\n").map(line => {
    if (!line.startsWith("cgroup,")) return line
    const fields = line.split(",")
    fields[5] = String((Number(fields[2]) - 1800000000) * 200000)
    return fields.join(",")
  }).join("\n")
  writeFileSync(harness.receipt, busy)
  expect(harness.run(args).stderr).toContain("active CPU at or below 15%")
  expect(readFileSync(harness.trace, "utf8")).toBe("")
  writeFileSync(harness.receipt, busy.replace("cgroup,active,1800000373,", "cgroup,active,1800000973,"))
  const result = harness.run(args)
  expect(result.status).toBe(1)
  expect(result.stderr).toContain("samples 5–8 seconds apart")
  expect(readFileSync(harness.trace, "utf8")).toBe("")
})

test("cleanup must be the terminal marker after the measured workload and final health", ({ harness }) => {
  const raw = passingReceipt()
  for (const malformed of [
    raw.replace("\nprobe_cleanup=complete", "").replace(timing, `probe_cleanup=complete\n${timing}`),
    raw.replace("\nworkload,completed,105", "").replace(timing, `${timing}\nworkload,completed,105`),
    `${raw}\nunexpected output after cleanup`,
  ]) {
    writeFileSync(harness.receipt, malformed)
    const result = harness.run(publish("aarch64", arm, harness.receipt))
    expect(result.status).toBe(1)
    expect(result.stderr).toContain("terminal cleanup follows measurements and final health")
    expect(readFileSync(harness.trace, "utf8")).toBe("")
  }
})

test("an older receipt or sibling image cannot authorize a different source revision", ({ harness }) => {
  writeFileSync(harness.receipt, passingReceipt().replace(`"version":"${version}"`, '"version":"1234567890ab"'))
  expect(harness.run(publish("aarch64", arm, harness.receipt)).stderr).toContain("matching Canary version")
  expect(readFileSync(harness.trace, "utf8")).toBe("")
  writeFileSync(harness.receipt, passingReceipt())
  expect(harness.run(publish("aarch64", amd, harness.receipt)).stderr).toContain("must use the Green-qualified image")
  expect(readFileSync(harness.trace, "utf8")).toBe("dev\n")
  expect(harness.run(publish("amd64", amd, harness.receipt), { FIXTURE_ARM_REVISION: revision.slice(0, -1) + "3" })
    .stderr).toContain("ARM64 image does not match the source revision")
  expect(readFileSync(harness.trace, "utf8")).toBe("dev\nimage\n")
  expect(harness.run(publish("aarch64", arm, harness.receipt), { FIXTURE_MAIN: "d".repeat(40) })
    .stderr).toContain("current reviewed dev")
  expect(readFileSync(harness.trace, "utf8")).toBe("dev\n")
  expect(harness.run(publish("aarch64", arm, harness.receipt), { CANARY_SOURCE_REF: "refs/heads/main", FIXTURE_MAIN: "d".repeat(40) })
    .stderr).toContain("current reviewed main")
  expect(readFileSync(harness.trace, "utf8")).toBe("main\n")
  expect(harness.run(publish("aarch64", arm, harness.receipt), { FIXTURE_BRANCH: "__detached__", FIXTURE_MAIN: "d".repeat(40) })
    .stderr).toContain("current reviewed dev")
  expect(readFileSync(harness.trace, "utf8")).toBe("dev\n")
  expect(harness.run(publish("aarch64", arm, harness.receipt), { CANARY_SOURCE_REF: "refs/heads/feature" })
    .stderr).toContain("refs/heads/dev or refs/heads/main")
  expect(readFileSync(harness.trace, "utf8")).toBe("")
})

test("a passing receipt permits both publications and stage only after anonymous readback", ({ harness }) => {
  for (const [arch, id] of [["aarch64", arm], ["amd64", amd]] as const) {
    const result = harness.run(publish(arch, id, harness.receipt))
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain(`digest=${digest}`)
    expect(readFileSync(harness.trace, "utf8")).toContain("login\nmanifest\ndev\npush\npull\nimage\nimage\n")
  }
  const badDigest = harness.run(stage(harness), { FIXTURE_PUBLIC_DIGEST: amd })
  expect(badDigest.stderr).toContain("Unexpected published digest")
  expect(existsSync(join(harness.app, "meitheal-hub-canary/config.yaml"))).toBe(false)
  const result = harness.run(stage(harness))
  expect(result.status, result.stderr).toBe(0)
  expect(readFileSync(join(harness.app, "meitheal-hub-canary/config.yaml"), "utf8")).toContain(`version: "${version}"`)
  expect(readFileSync(harness.trace, "utf8")).toBe("dev\nmain\npull\nimage\nimage\npull\nimage\nimage\ndev\n")
})

test("a passing receipt cannot overwrite an existing tag", ({ harness }) => {
  const args = publish("aarch64", arm, harness.receipt)
  const conflicting = harness.run(args, { FIXTURE_EXISTING_ID: amd })
  expect(conflicting.status).toBe(1)
  expect(conflicting.stderr).toContain("Published version already points to a different image")
  expect(readFileSync(harness.trace, "utf8")).not.toContain("push\n")
  const same = harness.run(args, { FIXTURE_EXISTING_ID: arm })
  expect(same.status, same.stderr).toBe(0)
  expect(same.stdout).toContain(`digest=${digest}`)
  expect(readFileSync(harness.trace, "utf8")).toContain("login\nmanifest\npull\nimage\npull\nimage\nimage\n")
  expect(readFileSync(harness.trace, "utf8")).not.toContain("push\n")
})

test("first publication accepts a missing package and rejects registry failures", ({ harness }) => {
  const args = publish("aarch64", arm, harness.receipt)
  const missing = harness.run(args, { FIXTURE_MANIFEST_ERROR: "name unknown" })
  expect(missing.status, missing.stderr).toBe(0)
  expect(readFileSync(harness.trace, "utf8")).toContain("login\nmanifest\ndev\npush\npull\n")

  for (const error of ["unauthorized", "denied", "too many requests", "service unavailable"]) {
    const failed = harness.run(args, { FIXTURE_MANIFEST_ERROR: error })
    expect(failed.status).toBe(1)
    expect(failed.stderr).toContain("Could not confirm the version tag is absent")
    expect(readFileSync(harness.trace, "utf8")).not.toContain("push\n")
  }
})

test("the versioned profile pins the public workload and parent bytes", ({ harness }) => {
  for (const [file, expected] of [["green-canary-workload.sh", hash], ["green-canary-driver-parent.sh", parentHash]]) {
    expect(createHash("sha256").update(readFileSync(join(root, "scripts", file!))).digest("hex")).toBe(expected)
  }
  for (const raw of [
    passingReceipt().replace(`benchmark_profile=${profile}\n`, ""),
    passingReceipt().replace(profile, "green-2000-task-v1"),
    passingReceipt().replace(profile, "green-2000-task-v3"),
    passingReceipt().replace(`benchmark_profile=${profile}`, `benchmark_profile=${profile}\nbenchmark_profile=${profile}`),
    passingReceipt().replaceAll(hash, "0".repeat(64)),
    passingReceipt().replaceAll(parentHash, "0".repeat(64)),
    passingReceipt().replace("sha256:5ce98efbe0fdb68edf92f3b98dfe78a70739a412d76083a42bfefbde8410824f", amd),
  ]) {
    writeFileSync(harness.receipt, raw)
    expect(harness.run(publish("aarch64", arm, harness.receipt)).status).toBe(1)
    expect(readFileSync(harness.trace, "utf8")).toBe("")
  }
})

test("legacy receipts and missing or altered driver telemetry cannot qualify under v2", ({ harness }) => {
  const variants = [
    passingReceipt().replaceAll(hash, "042901c8a19a12c1619348d12c199447992037955ef9070e67853cb9f7921549")
      .replace(`benchmark_profile=${profile}\n`, "").replace(clock, "").replace(driverCgroup, ""),
    passingReceipt().replace(clock, ""),
    passingReceipt().replace(clock, `${clock}\n${clock}`),
    passingReceipt().replace("uptime_end_cs=1030850", "uptime_end_cs=1000001"),
    passingReceipt().replace("user_end_usec=16000000", "user_end_usec=4999999"),
    passingReceipt().replace("system_end_usec=19000000", "system_end_usec=invalid"),
    passingReceipt().replace(driverCgroup, ""),
    passingReceipt().replace(driverCgroup, `${driverCgroup}\n${driverCgroup}`),
    passingReceipt().replace(driverCgroup, driverCgroup.replace(",max=0", "")),
    passingReceipt().replace(driverCgroup, driverCgroup.replace(",oom=0", "")),
    passingReceipt().replace(driverCgroup, driverCgroup.replace(",oom_kill=0", "")),
  ]
  for (const entry of driverCgroup.split(",").slice(2)) {
    variants.push(passingReceipt().replace(driverCgroup, driverCgroup.replace(`,${entry}`, "")))
  }
  for (const field of ["workload_status", "receipt_status", "memory.swap.max", "memory.swap.current", "max", "oom", "oom_kill", "oom_group_kill"]) {
    variants.push(passingReceipt().replace(driverCgroup, driverCgroup.replace(`,${field}=0`, `,${field}=1`)))
  }
  for (const [from, to] of [["memory.max=83886080", "memory.max=100663296"], ["cpu.max=100000 100000", "cpu.max=200000 100000"]]) {
    variants.push(passingReceipt().replace(driverCgroup, driverCgroup.replace(from!, to!)))
  }
  for (const raw of variants) {
    writeFileSync(harness.receipt, raw)
    expect(harness.run(publish("aarch64", arm, harness.receipt)).status).toBe(1)
    expect(readFileSync(harness.trace, "utf8")).toBe("")
  }
  writeFileSync(harness.receipt, passingReceipt().replace("oom_group_kill=0", "oom_group_kill=absent"))
  expect(harness.run(publish("aarch64", arm, harness.receipt)).status).toBe(0)
})

test("raw total App memory keeps strict 128/160 MiB boundaries and the 192 MiB hard cap", ({ harness }) => {
  const report = () => spawnSync("python3", ["scripts/verify-canary-green.py", "--report", harness.receipt, arm, version], { cwd: root, encoding: "utf8" })
  writeFileSync(harness.receipt, passingReceipt())
  const valid = report()
  expect(valid.status).toBe(0)
  expect(JSON.parse(valid.stdout).memory_current_bytes).toMatchObject({
    idle: { exclusive_limit: 128 * 1024 ** 2, p95: 128 * 1024 ** 2 - 1 },
    active: { exclusive_limit: 160 * 1024 ** 2, p95: 160 * 1024 ** 2 - 1 },
  })
  for (const [from, to, failure] of [
    [",134217727,", ",134217728,", "idle below 128 MiB"],
    [",167772159,", ",167772160,", "active below 160 MiB"],
    [",167772159,", ",201326593,", "Invalid cgroup memory reading"],
  ]) {
    writeFileSync(harness.receipt, passingReceipt().replaceAll(from!, to!))
    const result = report()
    expect(result.status).toBe(1)
    expect(result.stderr).toContain(failure)
  }
})

test("driver-only checks validate timing/cgroup evidence and cannot replace a release receipt", ({ harness }) => {
  writeFileSync(harness.receipt, [clock, timing, driverCgroup].join("\n"))
  const driver = spawnSync("python3", ["scripts/verify-canary-green.py", "--driver-only", "--report", harness.receipt], { cwd: root, encoding: "utf8" })
  expect(driver.status, driver.stderr).toBe(0)
  expect(JSON.parse(driver.stdout)).toMatchObject({ wall_seconds: 308.5, user_seconds: 11, system_seconds: 12, memory_max_bytes: 80 * 1024 ** 2 })
  expect(harness.run(publish("aarch64", arm, harness.receipt)).status).toBe(1)
  expect(readFileSync(harness.trace, "utf8")).toBe("")
  const withAuthority = spawnSync("python3", ["scripts/verify-canary-green.py", "--driver-only", harness.receipt, arm, version], { cwd: root, encoding: "utf8" })
  expect(withAuthority.status).not.toBe(0)
})

test("v2 retains the fixed seed, ordered complete cycles, helper and App resource limits", ({ harness }) => {
  const firstRoutes = "http,today,200,0.020000\nhttp,list,200,0.020000"
  for (const raw of [
    passingReceipt().replace('{"synthetic_tasks":2000}', '{"synthetic_tasks":1999}'),
    passingReceipt().replace("workload,completed,105", "workload,completed,104"),
    passingReceipt().replace("http,today,200,0.020000\n", ""),
    passingReceipt().replace(firstRoutes, "http,list,200,0.020000\nhttp,today,200,0.020000"),
    passingReceipt().replace("http,create,201,0.020000", "http,create,200,0.020000"),
    passingReceipt().replace("layer=sha256:5070b31eb4c50bf7d0297a1a5aee25bc13ff29894e87354610f6b8b6a445e07e", `layer=${amd}`),
    passingReceipt().replace("limits,201326592,0,100000 100000", "limits,268435456,0,100000 100000"),
    passingReceipt().replace(`\n${clock}`, "").replace("cgroup_fields,", `${clock}\ncgroup_fields,`),
  ]) {
    writeFileSync(harness.receipt, raw)
    expect(harness.run(publish("aarch64", arm, harness.receipt)).status).toBe(1)
    expect(readFileSync(harness.trace, "utf8")).toBe("")
  }
})

test("seed completion, installed-before snapshot and initial health must precede the first measurement", ({ harness }) => {
  const args = publish("aarch64", arm, harness.receipt)
  expect(harness.run(args).status).toBe(0)
  for (const prefix of ['{"synthetic_tasks":', "installed_canary_before=", '{"status":']) {
    for (const marker of ["cgroup,idle,", "workload,completed,105"]) {
      const lines = passingReceipt().split("\n")
      const prerequisite = lines.splice(lines.findIndex(line => line.startsWith(prefix)), 1)[0]!
      lines.splice(lines.findIndex(line => line.startsWith(marker)) + 1, 0, prerequisite)
      writeFileSync(harness.receipt, lines.join("\n"))
      const result = harness.run(args)
      expect(result.status).toBe(1)
      expect(result.stderr).toContain("seed, installed snapshot and initial health precede measurements")
      expect(readFileSync(harness.trace, "utf8")).toBe("")
    }
  }
})
