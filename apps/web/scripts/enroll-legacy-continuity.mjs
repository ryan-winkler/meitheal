import { createHash } from "node:crypto"
import { constants, lstatSync } from "node:fs"
import { mkdir, open } from "node:fs/promises"
import { dirname, isAbsolute, relative, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { openDatabaseForStartup, withStartupWriteTransaction } from "./database-client.mjs"
import { applyStartupTaskSchema, applyStartupBoardSchema } from "./task-schema-startup.mjs"
import { registerConsumedOperatorAdmission } from "./startup-board-admission.mjs"
import { currentBoardGrantRevision, prepareInitialBoardGrant, syncDirectory } from "./board-grant-journal.mjs"

const digest = bytes => createHash("sha256").update(bytes).digest("hex")
const denied = message => { throw new Error(`CONTINUITY_ENROLLMENT_DENIED: ${message}`) }

function assertNoSymlinks(path) {
  for (let part = resolve(path); ; part = dirname(part)) {
    const stats = lstatSync(part, { throwIfNoEntry: false })
    if (stats?.isSymbolicLink()) denied("symlink path")
    if (dirname(part) === part) return
  }
}

async function privateFile(path) {
  assertNoSymlinks(path)
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const stats = await file.stat()
    if (!stats.isFile() || (stats.mode & 0o077) !== 0 || ![0, process.getuid?.()].includes(stats.uid)) denied("custody file must be a private operator-owned regular file")
    if (stats.size > 65536) denied("custody file too large")
    return await file.readFile()
  } finally { await file.close() }
}

async function hashRegularFile(path) {
  assertNoSymlinks(path)
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const before = await file.stat()
    if (!before.isFile()) denied("checkpoint member must be regular")
    const hash = createHash("sha256")
    const buffer = Buffer.allocUnsafe(64 * 1024)
    let total = 0
    for (;;) {
      const { bytesRead } = await file.read(buffer, 0, buffer.length, null)
      if (!bytesRead) break
      total += bytesRead
      if (total > before.size) denied("checkpoint changed while hashing")
      hash.update(buffer.subarray(0, bytesRead))
    }
    const after = await file.stat()
    const currentPath = lstatSync(path, { throwIfNoEntry: false })
    if (!currentPath?.isFile() || currentPath.isSymbolicLink() || currentPath.dev !== before.dev || currentPath.ino !== before.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || total !== after.size) denied("checkpoint changed while hashing")
    return hash.digest("hex")
  } finally { await file.close() }
}

async function databaseFamily(database) {
  const result = {}
  for (const [name, suffix] of [["database", ""], ["wal", "-wal"], ["shm", "-shm"], ["journal", "-journal"]]) {
    const file = database + suffix
    result[name] = lstatSync(file, { throwIfNoEntry: false }) ? await hashRegularFile(file) : null
  }
  return result
}

const sameFamily = (left, right) => right && Object.keys(left).every(name => left[name] === right[name]) && Object.keys(right).length === 4

/**
 * Offline operator trust boundary. This tool does not mint or establish currency.
 * The protected external current.json is supplied by the independent current-checkpoint procedure.
 */
export async function enrollLegacyContinuity({ database, markerPath, custodyDirectory, manifestPath, archivePath, installationId, appSlug, image, source }) {
  for (const path of [database, markerPath, custodyDirectory, manifestPath, archivePath]) if (!isAbsolute(path)) denied("absolute paths required")
  const dataDirectory = dirname(resolve(database))
  const insideData = path => { const rel = relative(dataDirectory, resolve(path)); return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel)) }
  if ([custodyDirectory, manifestPath, archivePath].some(insideData)) denied("custody and archive must be outside App data")
  assertNoSymlinks(custodyDirectory)
  const custodyStats = lstatSync(custodyDirectory)
  if (!custodyStats.isDirectory() || (custodyStats.mode & 0o077) !== 0 || ![0, process.getuid?.()].includes(custodyStats.uid)) denied("custody directory must be private and operator-owned")
  const manifestBytes = await privateFile(manifestPath)
  const manifest = JSON.parse(manifestBytes.toString("utf8"))
  const current = JSON.parse((await privateFile(resolve(custodyDirectory, "current.json"))).toString("utf8"))
  if (manifest.kind !== "meitheal-current-legacy-checkpoint-v1" || current.kind !== "meitheal-current-continuity-attestation-v1") denied("unsupported proof contract")
  if (!/^[a-zA-Z0-9-]{1,100}$/.test(manifest.checkpointId ?? "") || current.checkpointId !== manifest.checkpointId || current.manifestSha256 !== digest(manifestBytes)) denied("current proof does not bind exact manifest")
  if (current.state !== "current" || current.coreOwnerVerified !== true || current.appStopped !== true || current.noNewerGrantOrLifecycleChange !== true || typeof current.verificationId !== "string" || current.verificationId.length < 8) denied("independent current cold-checkpoint attestation required")
  if (!installationId || !appSlug || !/@sha256:[a-f0-9]{64}$/.test(image ?? "") || !/^[a-f0-9]{40}$/.test(source ?? "")) denied("exact installation, App, immutable image and source required")
  for (const [name, expected] of Object.entries({ installationId, appSlug, image, source })) {
    if (manifest[name] !== expected || current[name] !== expected) denied(`foreign ${name}`)
  }
  if (await hashRegularFile(archivePath) !== manifest.archiveSha256) denied("archive checksum mismatch")
  const before = await databaseFamily(database)
  if (!before.database || !sameFamily(before, manifest.databaseFamily)) denied("cold database family mismatch")
  if (before.journal) denied("unresolved rollback journal")
  assertNoSymlinks(markerPath)
  if (lstatSync(markerPath, { throwIfNoEntry: false })) denied("marker already exists")
  const pending = resolve(dirname(markerPath), "meitheal-board-grants-pending")
  if (lstatSync(pending, { throwIfNoEntry: false })) denied("pending journal must be absent")

  // Durable no-clobber consumption precedes opening SQLite, migrations and any grant publication.
  // A failed or interrupted attempt is deliberately not reusable.
  const consumedDirectory = resolve(custodyDirectory, "consumed")
  await mkdir(consumedDirectory, { mode: 0o700 }) .catch(error => { if (error?.code !== "EEXIST") throw error })
  assertNoSymlinks(consumedDirectory)
  const consumedStats = lstatSync(consumedDirectory)
  if (!consumedStats.isDirectory() || (consumedStats.mode & 0o077) !== 0 || ![0, process.getuid?.()].includes(consumedStats.uid)) denied("consumed proofs directory must be private and operator-owned")
  const receipt = await open(resolve(consumedDirectory, manifest.checkpointId + ".json"), "wx", 0o600)
  try {
    await receipt.writeFile(JSON.stringify({ status: "consumed-before-enrollment", checkpointId: manifest.checkpointId, manifestSha256: digest(manifestBytes) }) + "\n")
    await receipt.sync()
    await syncDirectory(consumedDirectory)
    await syncDirectory(custodyDirectory)
    const client = await openDatabaseForStartup("file:" + database, { markerPath })
    try {
      let revision
      await withStartupWriteTransaction(client, async tx => {
        // SQLite rebuilds/updates SHM as it opens and acquires the writer. Its original
        // bytes were checked before opening; only persistent DB/WAL bytes must remain
        // identical under the writer before the first schema/enrollment mutation.
        const lockedFamily = await databaseFamily(database)
        const walUnchanged = lockedFamily.wal === before.wal || (before.wal === null && lockedFamily.wal === digest(Buffer.alloc(0)))
        if (lockedFamily.database !== before.database || !walUnchanged || lockedFamily.journal) denied("cold persistent files changed before enrollment")
        await applyStartupTaskSchema(tx)
        const named = await tx.execute("SELECT 1 FROM task_boards WHERE id <> 'household' LIMIT 1")
        const policies = await tx.execute("SELECT 1 FROM organization_access_policies LIMIT 1")
        if (named.rows.length || policies.rows.length) denied("only verified legacy pre-grant data can enroll")
        const integrity = await tx.execute("PRAGMA integrity_check(1)")
        const foreign = await tx.execute("PRAGMA foreign_key_check")
        if (integrity.rows[0]?.integrity_check !== "ok" || foreign.rows.length) denied("database integrity check failed")
        const admitted = await applyStartupBoardSchema(client, tx, undefined, { operatorAdmission: registerConsumedOperatorAdmission() })
        if (admitted.state !== "ready") denied("consumed current custody did not admit ordinary Board conversion")
        revision = admitted.revision
      })
      if (await currentBoardGrantRevision(client, markerPath) !== revision) denied("committed publication pending")
      await receipt.writeFile(JSON.stringify({ status: "enrolled", revision }) + "\n")
      await receipt.sync()
      return { status: "enrolled", revision }
    } finally { client.close() }
  } finally { await receipt.close() }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2)
  const options = {}
  const names = { "--database": "database", "--marker": "markerPath", "--custody-directory": "custodyDirectory", "--manifest": "manifestPath", "--archive": "archivePath", "--installation": "installationId", "--app-slug": "appSlug", "--image": "image", "--source": "source" }
  try {
    for (let i = 0; i < args.length; i += 2) {
      if (!names[args[i]] || !args[i + 1]) denied("unknown or incomplete argument")
      options[names[args[i]]] = args[i + 1]
    }
    const result = await enrollLegacyContinuity(options)
    console.log(JSON.stringify(result))
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Continuity enrollment failed")
    process.exitCode = 1
  }
}
