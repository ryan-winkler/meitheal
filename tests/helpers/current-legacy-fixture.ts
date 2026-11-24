import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { chmod, lstat, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path"
import { enrollLegacyContinuity } from "../../apps/web/scripts/enroll-legacy-continuity.mjs"

/** Explicit operator evidence for a stopped synthetic predecessor created by this
 * test. Never call for an unknown/replayed database or from general ensureSchema.
 * The caller must close all fixture writers before this one-shot checkpoint. */
export async function enrollCurrentOwnedLegacyFixture(input: {
  database: string
  markerPath: string
  provenance: "created-in-this-test-and-never-restored"
}) {
  assert.equal(input.provenance, "created-in-this-test-and-never-restored")
  assert.ok(isAbsolute(input.database) && isAbsolute(input.markerPath))
  const database = resolve(input.database)
  const data = dirname(database)
  assert.ok(data.startsWith(resolve(tmpdir()) + "/meitheal-"), "Only an owned synthetic temp database is eligible")
  assert.equal(dirname(resolve(input.markerPath)), data)
  const uid = process.getuid?.()
  assert.equal(typeof uid, "number")
  const stat = await lstat(database)
  assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.uid === uid)
  const custodyDirectory = await mkdtemp(join(tmpdir(), "meitheal-current-legacy-custody-"))
  await chmod(custodyDirectory, 0o700)
  assert.ok(relative(data, custodyDirectory).startsWith(".."), "Operator custody must be outside App data")
  const hash = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex")
  const family: Record<string, string | null> = {}
  const files: string[] = []
  for (const [key, suffix] of [["database", ""], ["wal", "-wal"], ["shm", "-shm"], ["journal", "-journal"]] as const) {
    try {
      const path = database + suffix
      const state = await lstat(path)
      assert.ok(state.isFile() && !state.isSymbolicLink() && state.uid === uid)
      family[key] = hash(await readFile(path))
      files.push(basename(path))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      family[key] = null
    }
  }
  assert.equal(family.journal, null, "The synthetic predecessor must be cleanly stopped")
  const archivePath = join(custodyDirectory, "checkpoint.tar")
  execFileSync("tar", ["-cf", archivePath, "-C", data, ...files])
  await chmod(archivePath, 0o600)
  const identity = { installationId: "explicit-owned-legacy-fixture", appSlug: "meitheal_canary",
    image: "ghcr.io/example/meitheal-fixture@sha256:" + "a".repeat(64), source: "b".repeat(40) }
  const checkpointId = "known-current-owned-fixture-" + randomUUID()
  const manifest = { kind: "meitheal-current-legacy-checkpoint-v1", checkpointId, ...identity,
    archiveSha256: hash(await readFile(archivePath)), databaseFamily: family }
  const manifestBytes = JSON.stringify(manifest)
  const manifestPath = join(custodyDirectory, "manifest.json")
  await writeFile(manifestPath, manifestBytes, { mode: 0o600 })
  await writeFile(join(custodyDirectory, "current.json"), JSON.stringify({
    kind: "meitheal-current-continuity-attestation-v1", checkpointId, manifestSha256: hash(manifestBytes), ...identity,
    state: "current", coreOwnerVerified: true, appStopped: true, noNewerGrantOrLifecycleChange: true,
    verificationId: "synthetic-test-created-owned-file-and-closed-all-writers",
  }), { mode: 0o600 })
  const result = await enrollLegacyContinuity({ database, markerPath: input.markerPath, custodyDirectory,
    manifestPath, archivePath, ...identity })
  assert.equal(result.status, "enrolled")
  return { ...result, custodyDirectory }
}
