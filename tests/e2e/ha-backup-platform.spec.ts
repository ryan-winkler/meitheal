/**
 * Home Assistant backup ownership contract.
 *
 * Meitheal uses Supervisor-managed cold backups. Supervisor stops the app
 * before archiving /data, so the SQLite database, WAL, and shared-memory files
 * cannot change while the backup is being created.
 *
 * @see https://contributors.home-assistant.io/apps/reference/configuration/#backups
 */
import * as fs from "node:fs"
import * as path from "node:path"

import { expect, test } from "@playwright/test"

const repoRoot = path.join(process.cwd(), "..")

function readRepositoryFile(relativePath: string): string {
  return fs.readFileSync(path.join(repoRoot, relativePath), "utf-8")
}

test.describe("Home Assistant backup contract", () => {
  test("stable and canary use Supervisor-managed cold backups", () => {
    for (const configPath of [
      "meitheal-hub/config.yaml",
      "meitheal-hub-canary/config.yaml",
    ]) {
      const config = readRepositoryFile(configPath)

      expect(config).toMatch(/^backup: cold$/m)
      expect(config).not.toMatch(/^backup_pre:/m)
      expect(config).not.toMatch(/^backup_post:/m)
    }
  })

  test("the manifest excludes only logs and temporary files", () => {
    for (const configPath of [
      "meitheal-hub/config.yaml",
      "meitheal-hub-canary/config.yaml",
    ]) {
      const config = readRepositoryFile(configPath)

      const exclusions = config
        .match(/^backup_exclude:\r?\n((?:[ \t]+-.*\r?\n)+)/m)?.[1]
        ?.trim().split(/\r?\n/).map(line => line.trim()).sort()

      expect(exclusions).toEqual(["- \"*.log\"", "- \"*.tmp\""])
    }
  })

  test("legacy hot-backup hooks are absent", () => {
    const removedPaths = [
      "integrations/home-assistant/custom_components/meitheal/backup.py",
      "meitheal-hub/rootfs/etc/services.d/meitheal/backup-pre.sh",
      "meitheal-hub/rootfs/etc/services.d/meitheal/backup-post.sh",
    ]

    for (const relativePath of removedPaths) {
      expect(fs.existsSync(path.join(repoRoot, relativePath))).toBe(false)
    }
  })

  test("operator documentation states the restore and integrity gates", () => {
    const runbook = readRepositoryFile("docs/kcs/home-assistant-backup-and-restore.md")

    expect(runbook).toContain("Supervisor-managed cold backups")
    expect(runbook).toContain("PRAGMA integrity_check")
    expect(runbook).toContain("Tier 2")
  })
})
