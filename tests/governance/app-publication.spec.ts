import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
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

test("canary image publication cannot advance App Store discovery", () => {
  const workflows = join(root, ".github/workflows")
  const canary = readFileSync(join(workflows, "publish-canary-images.yml"), "utf8")
  const stable = readFileSync(join(workflows, "publish-addon-images.yml"), "utf8")
  const shared = readFileSync(join(workflows, "publish-app.yml"), "utf8")

  expect(canary).not.toContain("ADDON_REPO_TOKEN")
  expect(stable).toContain("ADDON_REPO_TOKEN")
  expect(shared).toMatch(/^  promote:\n    if: inputs\.channel == 'stable'$/m)
  expect(shared).toContain('node scripts/app-release.mjs stage stable "$VERSION" app-repository')
})

test("image metadata accepts only supported literal architectures and matching bases", () => {
  for (const arch of ["amd64", "aarch64"]) {
    const result = spawnSync(process.execPath, ["scripts/app-release.mjs", "image", "canary", arch, revision.slice(0, 12), revision], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_REF: "refs/heads/main" },
    })
    expect(result.status, result.stderr).toBe(0)
    expect(JSON.parse(result.stdout).base).toMatch(new RegExp(`/${arch}-base:`))
  }
  for (const arch of [".*", "amd64|aarch64", "(a+)+$", "constructor", "__proto__"]) {
    const result = release("image", "canary", arch, revision.slice(0, 12), revision)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain("Expected amd64 or aarch64")
  }
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
