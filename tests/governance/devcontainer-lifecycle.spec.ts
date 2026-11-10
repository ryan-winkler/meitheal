import { spawnSync } from "node:child_process"
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { expect, test } from "@playwright/test"

const root = fileURLToPath(new URL("../..", import.meta.url))

/** Isolated engine/CLI fixtures never access real containers. */
function launch(command: string, existing: boolean, cli = false, tools = true, backend = "docker", listFail = false, project?: string, aliasMode = "") {
  const fixture = mkdtempSync(join(backend === "distrobox" ? homedir() : tmpdir(), "meitheal-container-launch-"))
  try {
    const bin = join(fixture, "bin")
    mkdirSync(bin)
    mkdirSync(join(fixture, "scripts"))
    mkdirSync(join(fixture, ".devcontainer"))
    copyFileSync(join(root, "scripts/devcontainer-up.sh"), join(fixture, "scripts/devcontainer-up.sh"))
    symlinkSync(process.execPath, join(bin, "node"))
    symlinkSync("/usr/bin/dirname", join(bin, "dirname"))
    const calls = join(fixture, "calls.jsonl")
    writeFileSync(calls, "")
    for (const tool of ["docker", ...(backend === "docker" ? [] : ["podman"]), ...(backend === "distrobox" ? ["flatpak-spawn"] : []), ...(backend === "podman" ? ["podman-compose"] : []), ...(cli ? ["devcontainer"] : [])]) {
      writeFileSync(join(bin, tool), `#!/usr/bin/env node
const fs = require("node:fs")
const rawArgs = process.argv.slice(2)
const args = rawArgs[0] === "--host" && rawArgs[1] === "podman" ? rawArgs.slice(2) : rawArgs
fs.appendFileSync(process.env.LAUNCH_CALLS, JSON.stringify([${JSON.stringify(tool)}, ...args, "project=" + (process.env.COMPOSE_PROJECT_NAME || "")]) + "\\n")
if (${JSON.stringify(tool)} === "docker" && process.env.LAUNCH_BACKEND !== "docker" && args.includes("version")) process.exit(1)
if (args[0] === "ps") {
  if (process.env.LAUNCH_LIST_FAIL === "1") process.exit(125)
  if (process.env.LAUNCH_EXISTING === "1") {
    const alias = args.some(arg => arg.startsWith("label=") && arg.includes("=/var/home/"))
    if (!process.env.LAUNCH_ALIAS_MODE || alias || process.env.LAUNCH_ALIAS_MODE === "deduplicate") console.log("stopped-editor")
    if (alias && process.env.LAUNCH_ALIAS_MODE === "ambiguous") console.log("another-editor")
  }
}
if (args[0] === "inspect") console.log(process.env.COMPOSE_PROJECT_NAME || "workspace_devcontainer")
if (args.includes("exec") && process.env.LAUNCH_TOOLS !== "1") process.exit(1)
`, { mode: 0o700 })
    }
    const result = spawnSync("/bin/bash", [join(fixture, "scripts/devcontainer-up.sh"), command], {
      encoding: "utf8",
      env: { PATH: bin, LAUNCH_ALIAS_MODE: aliasMode, ...(backend === "distrobox" ? { DISTROBOX_ENTER_PATH: "/usr/bin/distrobox-enter" } : {}), LAUNCH_BACKEND: backend, LAUNCH_LIST_FAIL: listFail ? "1" : "0", LAUNCH_CALLS: calls, LAUNCH_EXISTING: existing ? "1" : "0", LAUNCH_TOOLS: tools ? "1" : "0", ...(project ? { COMPOSE_PROJECT_NAME: project } : {}) },
    })
    return { status: result.status, error: result.stderr, calls: readFileSync(calls, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as string[]) }
  } finally { rmSync(fixture, { recursive: true }) }
}

for (const backend of ["docker", "podman", "podman-provider"]) {
  test(`${backend} recovers its workspace editor and preserves the generated image`, () => {
    const result = launch("up", true, false, true, backend)
    expect(result.status, result.error).toBe(0)
    const listing = result.calls.find(args => args[1] === "ps")!
    expect(listing).toEqual(expect.arrayContaining(["--all", "--quiet", "label=com.docker.compose.service=ha-devcontainer"]))
    expect(listing.some(arg => arg.startsWith("label=devcontainer.local_folder="))).toBe(true)
    expect(result.calls).toContainEqual(expect.arrayContaining(["start", "ha-devcontainer", "project=workspace_devcontainer"]))
    expect(result.calls.filter(args => args.includes("up")).every(args => args.includes("--no-recreate"))).toBe(true)
  })

  test(`${backend} creates a fresh editor only after a successful empty listing`, () => {
    const fresh = launch("up", false, true, true, backend)
    expect(fresh.status, fresh.error).toBe(0)
    expect(fresh.calls).toContainEqual(expect.arrayContaining(["devcontainer", "up", "--workspace-folder"]))
    expect(fresh.calls.some(args => args[0] !== "devcontainer" && args.includes("up"))).toBe(false)
    expect(fresh.calls.some(args => args.some(arg => arg.startsWith("label=com.docker.compose.project.working_dir=") && arg.endsWith("/.devcontainer")))).toBe(true)
    const failed = launch("up", false, true, true, backend, true)
    expect(failed.status).toBe(125)
    expect(failed.calls).toContainEqual(expect.arrayContaining(["ps", "--all", "--quiet", "label=com.docker.compose.service=ha-devcontainer"]))
    expect(failed.calls.some(args => args[0] === "devcontainer" || args.includes("up"))).toBe(false)
  })
}

test("explicit project names are retained during recovery", () => {
  const result = launch("up", true, false, true, "podman-provider", false, "chosen-stack")
  expect(result.status, result.error).toBe(0)
  expect(result.calls).toContainEqual(expect.arrayContaining(["ps", "label=com.docker.compose.project=chosen-stack"]))
  expect(result.calls).toContainEqual(expect.arrayContaining(["start", "ha-devcontainer", "project=chosen-stack"]))
})

test("missing CLI or tools gives an actionable error without replacement", () => {
  const missing = launch("up", false)
  expect(missing.status).toBe(1)
  expect(missing.error).toContain("Reopen in Container")
  const old = launch("up", true, false, false)
  expect(old.status).toBe(1)
  expect(old.error).toContain("Rebuild it in the editor")
  expect(old.calls.some(args => args.includes("up") || args.includes("down"))).toBe(false)
})

test("restart retains existing images", () => {
  const result = launch("restart", true)
  expect(result.status, result.error).toBe(0)
  expect(result.calls.some(args => args.includes("restart"))).toBe(true)
  expect(result.calls.some(args => args.includes("down") || args.includes("up"))).toBe(false)
})


for (const mode of ["host-only", "deduplicate", "ambiguous"]) {
  test(`Distrobox workspace aliases are handled safely: ${mode}`, () => {
    const result = launch("up", true, true, true, "distrobox", false, undefined, mode)
    expect(result.status, result.error).toBe(mode === "ambiguous" ? 1 : 0)
    expect(result.calls.some(args => args.some(arg => arg.startsWith("label=devcontainer.local_folder=/var/home/")))).toBe(true)
    expect(result.calls.some(args => args.some(arg => arg.startsWith("label=com.docker.compose.project.working_dir=/var/home/")))).toBe(true)
    expect(result.calls.some(args => args[0] === "devcontainer")).toBe(false)
    if (mode === "ambiguous") {
      expect(result.error).toContain("Multiple editor containers")
      expect(result.calls.some(args => args.includes("start") || args.includes("up"))).toBe(false)
    } else expect(result.calls).toContainEqual(expect.arrayContaining(["start", "ha-devcontainer", "project=workspace_devcontainer"]))
  })
}
