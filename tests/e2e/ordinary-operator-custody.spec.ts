import { createHash } from "node:crypto"
import fs, { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { syncBuiltinESMExports } from "node:module"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "@playwright/test"
import {
  openDatabaseForStartup,
  withStartupWriteTransaction
} from "../../apps/web/scripts/database-client.mjs"
import { applyStartupTaskSchema } from "../../apps/web/scripts/task-schema-startup.mjs"
import { enrollLegacyContinuity } from "../../apps/web/scripts/enroll-legacy-continuity.mjs"
import { currentBoardGrantRevision } from "../../apps/web/scripts/board-grant-journal.mjs"

const hash = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex")
const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

async function fixture() {
  const work = await mkdtemp(join(tmpdir(), "meitheal-operator-custody-"))
  const data = join(work, "data"),
    custodyDirectory = join(work, "custody")
  await mkdir(data)
  await mkdir(custodyDirectory, { mode: 0o700 })
  const database = join(data, "legacy.db"),
    markerPath = join(data, "grants.json")
  // A stopped synthetic predecessor, not a fresh-creation or restored epoch claim.
  await writeFile(database, "")
  const client = await openDatabaseForStartup("file:" + database, { markerPath })
  try {
    await withStartupWriteTransaction(client, (tx) => applyStartupTaskSchema(tx))
  } finally {
    client.close()
  }
  const before = await readFile(database)
  const archivePath = join(custodyDirectory, "checkpoint.archive")
  await copyFile(database, archivePath)
  await chmod(archivePath, 0o600)
  const identity = {
    installationId: "current-synthetic-cold-checkpoint",
    appSlug: "meitheal_canary",
    image: "ghcr.io/example/meitheal@sha256:" + "a".repeat(64),
    source: "b".repeat(40)
  }
  const manifest = {
    kind: "meitheal-current-legacy-checkpoint-v1",
    checkpointId: "operator-checkpoint-a",
    ...identity,
    archiveSha256: hash(before),
    databaseFamily: { database: hash(before), wal: null, shm: null, journal: null }
  }
  const manifestBytes = JSON.stringify(manifest)
  const manifestPath = join(custodyDirectory, "manifest.json"),
    currentPath = join(custodyDirectory, "current.json")
  const current = {
    kind: "meitheal-current-continuity-attestation-v1",
    checkpointId: manifest.checkpointId,
    manifestSha256: hash(manifestBytes),
    ...identity,
    state: "current",
    coreOwnerVerified: true,
    appStopped: true,
    noNewerGrantOrLifecycleChange: true,
    verificationId: "independent-stopped-current-fixture"
  }
  await writeFile(manifestPath, manifestBytes, { mode: 0o600 })
  await writeFile(currentPath, JSON.stringify(current), { mode: 0o600 })
  return {
    work,
    before,
    current,
    currentPath,
    manifestPath,
    receipt: join(custodyDirectory, "consumed", manifest.checkpointId + ".json"),
    lease: join(custodyDirectory, ".continuity-operation"),
    options: { database, markerPath, custodyDirectory, manifestPath, archivePath, ...identity }
  }
}

// Instrument only filesystem scheduling, keeping the actual source parser,
// SQLite writer, custody files, one-shot receipt and journal protocol intact.
function pauseHash(path: string, occurrence = 1) {
  const original = fs.open,
    reached = deferred(),
    resume = deferred()
  let count = 0
  fs.open = (async (...args: Parameters<typeof fs.open>) => {
    const handle = await original(...args)
    if (String(args[0]) === path && ++count === occurrence) {
      const read = handle.read.bind(handle)
      let held = false
      handle.read = (async (...readArgs: unknown[]) => {
        if (!held) {
          held = true
          reached.resolve()
          await resume.promise
        }
        return Reflect.apply(read, handle, readArgs)
      }) as typeof handle.read
    }
    return handle
  }) as typeof fs.open
  syncBuiltinESMExports()
  return {
    reached: reached.promise,
    resume: resume.resolve,
    restore() {
      fs.open = original
      syncBuiltinESMExports()
    }
  }
}

for (const replacement of ["historical", "checkpoint-b", "manifest"] as const) {
  test(`superseding ${replacement} during archive hashing cannot consume or enroll the earlier proof`, async () => {
    const f = await fixture(),
      hold = pauseHash(f.options.archivePath)
    let attempt: Promise<unknown> | undefined
    try {
      attempt = enrollLegacyContinuity(f.options)
      // Observe rejection immediately, even if a scheduling assertion itself fails.
      const outcome = attempt.then(
        (value) => ({ value }),
        (error) => ({ error })
      )
      await hold.reached
      if (replacement === "manifest")
        await writeFile(f.manifestPath, JSON.stringify({ changed: true }), { mode: 0o600 })
      else
        await writeFile(
          f.currentPath,
          JSON.stringify({
            ...f.current,
            ...(replacement === "historical"
              ? { state: "historical" }
              : { checkpointId: "operator-checkpoint-b" })
          }),
          { mode: 0o600 }
        )
      hold.resume()
      expect(await outcome).toMatchObject({
        error: expect.objectContaining({ message: expect.stringContaining("superseded") })
      })
      expect(await readFile(f.options.database)).toEqual(f.before)
      await expect(readFile(f.receipt)).rejects.toMatchObject({ code: "ENOENT" })
      await expect(readFile(f.options.markerPath)).rejects.toMatchObject({ code: "ENOENT" })
      await expect(fs.stat(f.lease)).rejects.toMatchObject({ code: "ENOENT" })
    } finally {
      hold.resume()
      await attempt?.catch(() => {})
      hold.restore()
      await rm(f.work, { recursive: true, force: true })
    }
  })
}

test("one custody lease fences publishers through actual admission and publication; consumed proof cannot replay", async () => {
  const f = await fixture(),
    hold = pauseHash(f.options.database, 2)
  let attempt: Promise<unknown> | undefined
  try {
    attempt = enrollLegacyContinuity(f.options)
    await hold.reached
    expect(await readFile(f.receipt, "utf8")).toContain("consumed-before-enrollment")
    // The actual external publisher uses the same exclusive mkdir protocol.
    await expect(mkdir(f.lease, { mode: 0o700 })).rejects.toMatchObject({ code: "EEXIST" })
    hold.resume()
    const enrolled = (await attempt) as { status: string; revision: string }
    expect(enrolled.status).toBe("enrolled")
    expect(await readFile(f.receipt, "utf8")).toContain('"status":"enrolled"')
    await expect(fs.stat(f.lease)).rejects.toMatchObject({ code: "ENOENT" })
    const client = await openDatabaseForStartup("file:" + f.options.database, {
      markerPath: f.options.markerPath
    })
    try {
      expect(await currentBoardGrantRevision(client, f.options.markerPath)).toBe(enrolled.revision)
    } finally {
      client.close()
    }
    await rm(f.options.markerPath)
    await rm(join(f.options.markerPath, "..", "meitheal-board-grants-pending"), {
      recursive: true,
      force: true
    })
    for (const suffix of ["-wal", "-shm", "-journal"])
      await rm(f.options.database + suffix, { force: true })
    await copyFile(f.options.archivePath, f.options.database)
    await expect(enrollLegacyContinuity(f.options)).rejects.toMatchObject({ code: "EEXIST" })
    await expect(readFile(f.options.markerPath)).rejects.toMatchObject({ code: "ENOENT" })
  } finally {
    hold.resume()
    await attempt?.catch(() => {})
    hold.restore()
    await rm(f.work, { recursive: true, force: true })
  }
})

test("an existing custody operation is never automatically recovered or consumed", async () => {
  const f = await fixture()
  try {
    await mkdir(f.lease, { mode: 0o700 })
    await expect(enrollLegacyContinuity(f.options)).rejects.toMatchObject({ code: "EEXIST" })
    expect((await fs.stat(f.lease)).isDirectory()).toBe(true)
    expect(await readFile(f.options.database)).toEqual(f.before)
    await expect(readFile(f.receipt)).rejects.toMatchObject({ code: "ENOENT" })
    await expect(readFile(f.options.markerPath)).rejects.toMatchObject({ code: "ENOENT" })
  } finally {
    await rm(f.work, { recursive: true, force: true })
  }
})

test("writer rechecks current custody after consumed receipt; revoked proof rolls back and retains its failure receipt", async () => {
  const f = await fixture(),
    hold = pauseHash(f.options.database, 2)
  let attempt: Promise<unknown> | undefined
  try {
    attempt = enrollLegacyContinuity(f.options)
    const outcome = attempt.then(
      (value) => ({ value }),
      (error) => ({ error })
    )
    await hold.reached
    // An obsolete publisher that ignores the lease still cannot pass the final
    // writer check. This proof was current at consumption and stays consumed.
    await writeFile(f.currentPath, JSON.stringify({ ...f.current, state: "historical" }), {
      mode: 0o600
    })
    hold.resume()
    expect(await outcome).toMatchObject({
      error: expect.objectContaining({ message: expect.stringContaining("superseded") })
    })
    expect(await readFile(f.options.database)).toEqual(f.before)
    expect(await readFile(f.receipt, "utf8")).toContain("consumed-before-enrollment")
    expect(await readFile(f.receipt, "utf8")).not.toContain('"status":"enrolled"')
    await expect(readFile(f.options.markerPath)).rejects.toMatchObject({ code: "ENOENT" })
    await expect(fs.stat(f.lease)).rejects.toMatchObject({ code: "ENOENT" })
  } finally {
    hold.resume()
    await attempt?.catch(() => {})
    hold.restore()
    await rm(f.work, { recursive: true, force: true })
  }
})
