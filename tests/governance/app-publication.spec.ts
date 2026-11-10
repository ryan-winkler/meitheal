import { spawnSync } from "node:child_process"
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { expect, test } from "@playwright/test"

const root = fileURLToPath(new URL("../..", import.meta.url))
const revision = "abcdef1234567890abcdef1234567890abcdef12"
const stableManifest = readFileSync(join(root, "meitheal-hub/config.yaml"), "utf8")
const stableVersion = stableManifest.match(/^version: "([^"]+)"$/m)?.[1]

function release(...args: string[]) {
  return spawnSync(process.execPath, ["scripts/app-release.mjs", ...args], {
    cwd: root,
    encoding: "utf8",
  })
}

test("release preparation accepts only the expected event, version tag and branch", () => {
  expect(release("prepare", "stable", "push", `refs/tags/v${stableVersion}`, revision).stdout.trim()).toBe(`version=${stableVersion}`)
  expect(release("prepare", "stable", "workflow_dispatch", "refs/tags/vdifferent", revision).status).toBe(1)
  expect(release("prepare", "stable", "workflow_dispatch", "refs/heads/main", revision).status).toBe(1)
  expect(release("prepare", "stable", "pull_request", `refs/tags/v${stableVersion}`, revision).status).toBe(1)
  expect(release("prepare", "canary", "push", "refs/heads/main", revision).stdout.trim()).toBe("version=abcdef123456")
  expect(release("prepare", "canary", "push", "refs/heads/fork", revision).status).toBe(1)
  expect(release("prepare", "canary", "push", "refs/heads/main", "invalid").status).toBe(1)
})

test("hosted canary checks cannot publish packages or advance App Store discovery", () => {
  const workflows = join(root, ".github/workflows")
  const canary = readFileSync(join(workflows, "publish-canary-images.yml"), "utf8")
  const stable = readFileSync(join(workflows, "publish-addon-images.yml"), "utf8")
  const shared = readFileSync(join(workflows, "publish-app.yml"), "utf8")
  const builder = readFileSync(join(workflows, "build-app-image.yml"), "utf8")

  expect(canary).toMatch(/^permissions:\n  contents: read\n  packages: none$/m)
  expect(canary).toContain("architecture: amd64\n            runner: ubuntu-24.04\n")
  expect(canary).toContain("architecture: aarch64\n            runner: ubuntu-24.04-arm\n")
  expect(canary).toContain("run: bash scripts/build-app-release-image.sh build-only")
  expect(canary).not.toMatch(/packages: write|publish-app\.yml|build-app-image\.yml|secrets\.|GH_TOKEN/)
  expect(stable).toContain("ADDON_REPO_TOKEN")
  expect(builder).toContain("run: bash scripts/build-app-release-image.sh publish")
  expect(shared).toContain("&& inputs.channel == 'stable'")
  expect(shared).toMatch(/^  promote:\n    if: inputs\.channel == 'stable'$/m)
  expect(shared).toContain('node scripts/app-release.mjs stage stable "$VERSION" app-repository')
})

test("staging one channel preserves the other channel and the source manifest", () => {
  const fixture = mkdtempSync(join(tmpdir(), "meitheal-release-"))
  const source = join(root, "meitheal-hub-canary/config.yaml")
  const before = readFileSync(source, "utf8")
  try {
    mkdirSync(join(fixture, ".git"))
    mkdirSync(join(fixture, "meitheal-hub"))
    const stable = join(fixture, "meitheal-hub/config.yaml")
    writeFileSync(stable, 'version: "999999.0.0"\n')

    const canary = release("stage", "canary", "abcdef123456", fixture)
    expect(canary.stderr).toBe("")
    expect(canary.status).toBe(0)
    expect(readFileSync(join(fixture, "meitheal-hub-canary/config.yaml"), "utf8")).toContain('version: "abcdef123456"')
    expect(readFileSync(stable, "utf8")).toBe('version: "999999.0.0"\n')
    expect(readFileSync(source, "utf8")).toBe(before)
    expect(existsSync(join(fixture, "repository.yaml"))).toBe(true)
    expect(existsSync(join(fixture, "meitheal-hub-canary/translations/en.yaml"))).toBe(true)

    expect(release("stage", "stable", String(stableVersion), fixture).stderr).toContain("would move backwards")
    expect(release("stage", "canary", "invalid", fixture).status).toBe(1)
  } finally {
    rmSync(fixture, { recursive: true })
  }
})

test("staging both channels uses the reviewed AppArmor policy", () => {
  const fixture = mkdtempSync(join(tmpdir(), "meitheal-release-"))
  const profile = readFileSync(join(root, "meitheal-hub/apparmor.txt"))
  try {
    mkdirSync(join(fixture, ".git"))
    expect(release("stage", "stable", String(stableVersion), fixture).status).toBe(0)
    expect(release("stage", "canary", "abcdef123456", fixture).status).toBe(0)

    for (const directory of ["meitheal-hub", "meitheal-hub-canary"]) {
      expect(readFileSync(join(fixture, directory, "config.yaml"), "utf8")).toMatch(/^apparmor: true$/m)
      expect(readFileSync(join(fixture, directory, "apparmor.txt"))).toEqual(profile)
    }
  } finally {
    rmSync(fixture, { recursive: true, force: true })
  }
})

test("staging rejects destination links outside the App repository", () => {
  const fixture = mkdtempSync(join(tmpdir(), "meitheal-release-"))
  try {
    mkdirSync(join(fixture, ".git"))
    mkdirSync(join(fixture, "redirect"))
    symlinkSync(join(fixture, "redirect"), join(fixture, "meitheal-hub-canary"))
    expect(release("stage", "canary", "abcdef123456", fixture).stderr).toContain("Unexpected path")
    expect(existsSync(join(fixture, "redirect/config.yaml"))).toBe(false)
  } finally {
    rmSync(fixture, { recursive: true })
  }
})

test("all release entrypoints retain one canonical Canary and reject extra App manifests", () => {
  const fixture = mkdtempSync(join(tmpdir(), "meitheal-release-policy-"))
  const source = join(fixture, "source")
  const destination = join(fixture, "destination")
  try {
    mkdirSync(join(source, "scripts"), { recursive: true })
    cpSync(join(root, "scripts/app-release.mjs"), join(source, "scripts/app-release.mjs"))
    cpSync(join(root, "repository.yaml"), join(source, "repository.yaml"))
    for (const directory of ["meitheal-hub", "meitheal-hub-canary"]) {
      cpSync(join(root, directory), join(source, directory), { recursive: true })
    }
    mkdirSync(join(destination, ".git"), { recursive: true })
    mkdirSync(join(source, "tooling"))
    writeFileSync(join(source, "tooling/config.json"), '{"compilerOptions":{}}')
    const run = (...args: string[]) => spawnSync(process.execPath, [join(source, "scripts/app-release.mjs"), ...args], {
      cwd: source,
      encoding: "utf8",
      env: {
        ...process.env,
        GITHUB_EVENT_NAME: "workflow_dispatch",
        GITHUB_REF: args[1] === "stable" ? `refs/tags/v${stableVersion}` : "refs/heads/main",
      },
    })
    const commands = ["stable", "canary"].flatMap(channel => {
      const version = channel === "stable" ? String(stableVersion) : revision.slice(0, 12)
      const ref = channel === "stable" ? `refs/tags/v${version}` : "refs/heads/main"
      return [
        ["prepare", channel, "push", ref, revision],
        ["image", channel, "amd64", version, revision],
        ["image", channel, "aarch64", version, revision],
        ["stage", channel, version, destination],
      ]
    })
    for (const command of commands) {
      const result = run(...command)
      expect(result.stderr, command.join(" ")).toBe("")
      expect(result.status, command.join(" ")).toBe(0)
      if (command[0] === "image") {
        const family = command[1] === "canary" ? "meitheal-canary" : "meitheal"
        expect(JSON.parse(result.stdout)).toMatchObject({
          image: `ghcr.io/ryan-winkler/${family}-${command[2]}:${command[3]}`,
          platform: command[2] === "amd64" ? "linux/amd64" : "linux/arm64",
        })
      }
    }
    const before = readFileSync(join(destination, "meitheal-hub-canary/config.yaml"), "utf8")
    const extraManifests = [
      ["meitheal-settings", "config.yaml", 'name: "Settings Canary"\nslug: "meitheal_settings"\n'],
      ["meitheal-preview", "config.yml", "name: Preview\n'slug': meitheal_preview\n"],
      ["experimental", "config.json", '{"name":"Extra Canary","slug":"meitheal_extra"}'],
      ["meitheal-hub-canary", "config.json", '{"slug":"meitheal_canary"}'],
    ]
    for (const [directory, filename, manifest] of extraManifests) {
      const extra = join(source, directory!, filename!)
      mkdirSync(join(source, directory!), { recursive: true })
      writeFileSync(extra, manifest!)
      try {
        for (const command of commands) {
          const result = run(...command)
          expect(result.status, command.join(" ")).toBe(1)
          expect(result.stderr).toContain(`Unexpected App manifest ${directory}/${filename}`)
        }
      } finally {
        rmSync(extra)
      }
    }
    const extraDestination = join(destination, "meitheal-settings")
    mkdirSync(extraDestination)
    writeFileSync(join(extraDestination, "config.yaml"), 'slug: "meitheal_settings"\n')
    for (const channel of ["stable", "canary"]) {
      const version = channel === "stable" ? String(stableVersion) : revision.slice(0, 12)
      expect(run("stage", channel, version, destination).stderr).toContain("Unexpected App manifest meitheal-settings/config.yaml")
    }
    expect(readFileSync(join(destination, "meitheal-hub-canary/config.yaml"), "utf8")).toBe(before)
    rmSync(extraDestination, { recursive: true })

    const canary = join(source, "meitheal-hub-canary/config.yaml")
    const manifest = readFileSync(canary, "utf8")
    writeFileSync(canary, manifest.replace(/^slug: .+$/m, 'slug: "meitheal_settings"'))
    for (const command of commands) {
      expect(run(...command).stderr).toContain("Unexpected App slug")
    }
    writeFileSync(canary, manifest.replace(/^image: .+$/m, 'image: "ghcr.io/ryan-winkler/meitheal-settings-{arch}"'))
    for (const command of commands) {
      expect(run(...command).stderr).toContain("Unexpected App image template")
    }
  } finally {
    rmSync(fixture, { recursive: true, force: true })
  }
})
