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
const hash = "042901c8a19a12c1619348d12c199447992037955ef9070e67853cb9f7921549"

function passingReceipt() {
  const installed = `${amd} healthy 0 2026-01-01T00:00:00Z ${"d".repeat(64)}`
  const routes = ["today,200", "list,200", "search,200", "open,200", "create,201", "complete,200", "readback,200"]
  return [
    `image=${arm} architecture=arm64 bytes=123`,
    `helper_image=sha256:5ce98efbe0fdb68edf92f3b98dfe78a70739a412d76083a42bfefbde8410824f architecture=arm64 layer=sha256:5070b31eb4c50bf7d0297a1a5aee25bc13ff29894e87354610f6b8b6a445e07e`,
    `${hash}  /tmp/fixture/seed-and-run.sh`,
    `seed_and_driver_script_sha256=${hash}`,
    `{"status":"ok","service":"meitheal-web","version":"${version}"}`,
    `installed_canary_before=${installed}`,
    "limits,201326592,0,100000 100000",
    '{"synthetic_tasks":2000}',
    "seed=separate_cgroup,same_loopback_namespace,disposable_data_volume,fixed_helper",
    "driver=separate_cgroup,same_loopback_namespace,fixed_helper",
    "cgroup_fields,phase,epoch,memory_current,swap,cpu_usec,max,oom,oom_kill",
    ...Array.from({ length: 62 }, (_, index) =>
      `cgroup,${index < 12 ? "idle" : "active"},${1800000000 + index * 5},${index < 12 ? 67108863 : 100663295},0,${index * 750000},0,0,0`),
    ...Array.from({ length: 105 }, () => routes.map(route => `http,${route},0.350000`)).flat(),
    "workload,completed,105",
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
  if (args[0] !== "rev-parse") process.exit(98)
  console.log(args[1] === "HEAD" ? revision : (process.argv.includes("-C") ? app : root))
  process.exit(0)
}
if (tool === "gh") {
  appendFileSync(process.env.FIXTURE_TRACE, "main\\n")
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
    Config: { Labels: { "org.opencontainers.image.revision": arch === "aarch64" && process.env.FIXTURE_ARM_REVISION || revision,
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
  console.error("fixture: manifest unknown")
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
  writeFileSync(harness.receipt, '{"checks":{"idle below 64 MiB":true}}')
  expect(harness.run(args).stderr).toContain("Green receipt rejected")
  expect(harness.run(stage(harness)).stderr).toContain("Green receipt rejected")
  expect(readFileSync(harness.trace, "utf8")).toBe("")
})

test("receipt metrics and exact ARM64 config must pass before registry action", ({ harness }) => {
  writeFileSync(harness.receipt, passingReceipt().replace(`image=${arm}`, `image=${amd}`))
  expect(harness.run(publish("aarch64", arm, harness.receipt)).stderr).toContain("exact ARM64 config ID")
  expect(readFileSync(harness.trace, "utf8")).toBe("")

  writeFileSync(harness.receipt, passingReceipt().replaceAll(",67108863,", ",67108864,")
    .replaceAll(",100663295,", ",100663296,").replaceAll("list,200,0.350000", "list,200,0.350001"))
  const result = harness.run(publish("aarch64", arm, harness.receipt))
  expect(result.status).toBe(1)
  expect(result.stderr).toContain("idle below 64 MiB, active below 96 MiB, each route p95 at or below 350 ms")
  expect(readFileSync(harness.trace, "utf8")).toBe("")
})

test("an older receipt or sibling image cannot authorize a different source revision", ({ harness }) => {
  writeFileSync(harness.receipt, passingReceipt().replace(`"version":"${version}"`, '"version":"1234567890ab"'))
  expect(harness.run(publish("aarch64", arm, harness.receipt)).stderr).toContain("matching Canary version")
  expect(readFileSync(harness.trace, "utf8")).toBe("")
  writeFileSync(harness.receipt, passingReceipt())
  expect(harness.run(publish("aarch64", amd, harness.receipt)).stderr).toContain("must use the Green-qualified image")
  expect(readFileSync(harness.trace, "utf8")).toBe("main\n")
  expect(harness.run(publish("amd64", amd, harness.receipt), { FIXTURE_ARM_REVISION: revision.slice(0, -1) + "3" })
    .stderr).toContain("ARM64 image does not match the source revision")
  expect(readFileSync(harness.trace, "utf8")).toBe("main\nimage\n")
  expect(harness.run(publish("aarch64", arm, harness.receipt), { FIXTURE_MAIN: "d".repeat(40) })
    .stderr).toContain("current reviewed main")
  expect(readFileSync(harness.trace, "utf8")).toBe("main\n")
})

test("a passing receipt permits both publications and stage only after anonymous readback", ({ harness }) => {
  for (const [arch, id] of [["aarch64", arm], ["amd64", amd]] as const) {
    const result = harness.run(publish(arch, id, harness.receipt))
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain(`digest=${digest}`)
    expect(readFileSync(harness.trace, "utf8")).toContain("login\nmanifest\nmain\npush\npull\nimage\nimage\n")
  }
  const badDigest = harness.run(stage(harness), { FIXTURE_PUBLIC_DIGEST: amd })
  expect(badDigest.stderr).toContain("Unexpected published digest")
  expect(existsSync(join(harness.app, "meitheal-hub-canary/config.yaml"))).toBe(false)
  const result = harness.run(stage(harness))
  expect(result.status, result.stderr).toBe(0)
  expect(readFileSync(join(harness.app, "meitheal-hub-canary/config.yaml"), "utf8")).toContain(`version: "${version}"`)
  expect(readFileSync(harness.trace, "utf8")).toBe("main\nmain\npull\nimage\nimage\npull\nimage\nimage\nmain\n")
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
