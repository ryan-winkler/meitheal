import { spawnSync } from "node:child_process"
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { expect, test } from "@playwright/test"

const root = fileURLToPath(new URL("../..", import.meta.url))

/** Run the launcher against isolated engine/CLI fixtures without accessing real containers. */
function launch(command: string, existing: boolean, cli = false, tools = true) {
  const fixture = mkdtempSync(join(tmpdir(), "meitheal-container-launch-"))
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
    writeFileSync(join(bin, "docker"), `#!/usr/bin/env node
const fs = require("node:fs")
const args = process.argv.slice(2)
fs.appendFileSync(process.env.LAUNCH_CALLS, JSON.stringify(["docker", ...args]) + "\\n")
if (args.includes("ps") && process.env.LAUNCH_EXISTING === "1") console.log("editor-container")
if (args.includes("exec") && process.env.LAUNCH_TOOLS !== "1") process.exit(1)
`, { mode: 0o700 })
    if (cli) writeFileSync(join(bin, "devcontainer"), `#!/usr/bin/env node
require("node:fs").appendFileSync(process.env.LAUNCH_CALLS, JSON.stringify(["devcontainer", ...process.argv.slice(2)]) + "\\n")
`, { mode: 0o700 })
    const result = spawnSync("/bin/bash", [join(fixture, "scripts/devcontainer-up.sh"), command], {
      encoding: "utf8",
      env: { PATH: bin, LAUNCH_CALLS: calls, LAUNCH_EXISTING: existing ? "1" : "0", LAUNCH_TOOLS: tools ? "1" : "0" },
    })
    return {
      status: result.status,
      error: result.stderr,
      calls: readFileSync(calls, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as string[]),
    }
  } finally {
    rmSync(fixture, { recursive: true })
  }
}

test("recovery starts the existing editor image and never recreates it from base Compose", () => {
  const result = launch("up", true)
  expect(result.status, result.error).toBe(0)
  expect(result.calls).toEqual(expect.arrayContaining([
    expect.arrayContaining(["start", "ha-devcontainer"]),
    expect.arrayContaining(["up", "-d", "--no-recreate", "grocy", "nodered"]),
  ]))
  expect(result.calls.filter(args => args.includes("up")).every(args => args.includes("--no-recreate"))).toBe(true)
})

test("fresh creation uses the Dev Containers CLI and configured Features", () => {
  const result = launch("up", false, true)
  expect(result.status, result.error).toBe(0)
  expect(result.calls).toContainEqual(expect.arrayContaining(["devcontainer", "up", "--workspace-folder"]))
  expect(result.calls.some(args => args[0] === "docker" && args.includes("up"))).toBe(false)
})

test("missing CLI or missing tools gives an actionable error without replacing containers", () => {
  const missing = launch("up", false)
  expect(missing.status).toBe(1)
  expect(missing.error).toContain("Reopen in Container")
  const oldImage = launch("up", true, false, false)
  expect(oldImage.status).toBe(1)
  expect(oldImage.error).toContain("Rebuild it in the editor")
  expect(oldImage.calls.some(args => args.includes("up") || args.includes("down"))).toBe(false)
})

test("restart retains the existing container image", () => {
  const result = launch("restart", true)
  expect(result.status, result.error).toBe(0)
  expect(result.calls.some(args => args.includes("restart"))).toBe(true)
  expect(result.calls.some(args => args.includes("down") || args.includes("up"))).toBe(false)
})
