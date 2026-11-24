import { randomUUID } from "node:crypto"
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs"
import { mkdir, open, readdir, rename, rm } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { acquireWriteTransaction, readLocalGrantRevision, retryStartupLock } from "./database-client.mjs"
import { boardGrantPath, boardGrantRevisionQuery, consumeDatabaseCreation, getBoardGrantPath, unwrapBoardGrantClient } from "./board-grant-context.mjs"
import { consumeOperatorAdmission, registerStartupBoardAdmission } from "./startup-board-admission.mjs"

export { boardGrantPath, getBoardGrantPath }
const revisionPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/
const pendingDirectory = path => join(dirname(path), "meitheal-board-grants-pending")
export const pendingFile = (path, revision) => join(pendingDirectory(path), revision + ".json")

function rejectSymlinkPath(path) {
  for (let part = resolve(path); ; part = dirname(part)) {
    if (lstatSync(part, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error("Board continuity refuses symlink paths")
    if (dirname(part) === part) return
  }
}

/** @type {Map<string, { stats: import("node:fs").BigIntStats, revision: string | null }>} */
const markerReads = new Map()
const MARKER_SETTLED_MS = 1_000

/**
 * @param {import("node:fs").BigIntStats} a
 * @param {import("node:fs").BigIntStats} b
 */
function sameMarkerStats(a, b) {
  return (
    a.dev === b.dev
    && a.ino === b.ino
    && a.size === b.size
    && a.mtimeNs === b.mtimeNs
    && a.ctimeNs === b.ctimeNs
    && a.birthtimeNs === b.birthtimeNs
  )
}

export async function readBoardGrantRevision(path = boardGrantPath) {
  try {
    // Every authority boundary checks the marker. One lstat proves the same
    // file is still in place: publication renames a new file over it and any
    // in-place change moves its change time. Only then reuse the parsed epoch.
    const current = lstatSync(path, { bigint: true, throwIfNoEntry: false })
    if (!current?.isFile() || current.size > 160n) return null
    const known = markerReads.get(path)
    if (known && sameMarkerStats(known.stats, current)) return known.revision
    // The marker is a bounded local file. Read the opened descriptor without
    // queueing each stat, read and close separately on the I/O worker pool.
    const file = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      const stats = fstatSync(file, { bigint: true })
      if (!stats.isFile() || stats.size > 160n) return null
      const bytes = Buffer.alloc(161)
      const bytesRead = readSync(file, bytes, 0, bytes.length, 0)
      if (BigInt(bytesRead) !== stats.size) return null
      const parsed = JSON.parse(bytes.toString("utf8", 0, bytesRead))?.epoch
      const revision = typeof parsed === "string" && revisionPattern.test(parsed) ? parsed : null
      // Remember only bytes read while the file kept the identity observed
      // before opening. File times can be coarser than successive writes, so a
      // marker changed within the last second is always read again.
      const settled = Date.now() - Number(current.ctimeMs) > MARKER_SETTLED_MS
      if (settled && sameMarkerStats(fstatSync(file, { bigint: true }), current)) markerReads.set(path, { stats: current, revision })
      else markerReads.delete(path)
      return revision
    } finally { closeSync(file) }
  } catch { return null }
}

export async function databaseRevision(db) {
  db = unwrapBoardGrantClient(db)
  const local = readLocalGrantRevision(db)
  const revision = local === undefined ? (await db.execute(boardGrantRevisionQuery)).rows[0]?.revision : local
  return typeof revision === "string" && revisionPattern.test(revision) ? revision : null
}

export async function syncDirectory(path) {
  const directory = await open(path, constants.O_DIRECTORY | constants.O_RDONLY | constants.O_NOFOLLOW)
  try { await directory.sync() } finally { await directory.close() }
}

export async function prepareGrantMarker(path, revision) {
  const directory = pendingDirectory(path)
  rejectSymlinkPath(path)
  rejectSymlinkPath(directory)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  if (!lstatSync(directory).isDirectory() || (lstatSync(directory).mode & 0o077) !== 0) throw new Error("Board pending journal must be a private directory")
  const file = await open(pendingFile(path, revision), "wx", 0o600)
  try {
    await file.writeFile(JSON.stringify({ epoch: revision }))
    await file.sync()
  } finally { await file.close() }
  await syncDirectory(directory)
  await syncDirectory(dirname(path))
}

export async function publishCommittedMarker(path, revision) {
  if (await readBoardGrantRevision(path) === revision) return true
  const prepared = pendingFile(path, revision)
  if (await readBoardGrantRevision(prepared) !== revision) return false
  try {
    await rename(prepared, path)
    await syncDirectory(dirname(path))
    return true
  } catch { return false }
}

export async function boardGrantStillCurrent(db, revision, path = getBoardGrantPath(db)) {
  return await readBoardGrantRevision(path) === revision && await databaseRevision(db) === revision
}

async function inspectBoardGrantRevision(db, path, retryRead = read => read()) {
  db = unwrapBoardGrantClient(db)
  const { marker, revision } = await retryRead(async () => ({
    marker: await readBoardGrantRevision(path),
    revision: await databaseRevision(db),
  }))
  if (revision === marker) return revision
  if (!revision || await readBoardGrantRevision(pendingFile(path, revision)) !== revision) return null
  const tx = await acquireWriteTransaction(db)
  try {
    if (await databaseRevision(tx) !== revision) return null
    return await publishCommittedMarker(path, revision) ? revision : null
  } finally { tx.close() }
}

export function currentBoardGrantRevision(db, path = getBoardGrantPath(db)) {
  return inspectBoardGrantRevision(db, path)
}

/** Only the creator's process-local capability may admit an empty epoch at startup. */
export async function initializeBoardGrantContinuity(client, tx) {
  if (!consumeDatabaseCreation(client)) return null
  return prepareInitialBoardGrant(tx, getBoardGrantPath(client))
}

/** Prove conversion authority on the same startup writer, then prepare its next excluded journal. */
export async function admitStartupBoardTransition(client, tx, operatorAdmission) {
  const path = getBoardGrantPath(client)
  const revision = await databaseRevision(tx)
  const created = consumeDatabaseCreation(client)
  const operator = consumeOperatorAdmission(operatorAdmission)
  if (!revision) {
    if (!created && !operator) return null
    const next = await prepareInitialBoardGrant(tx, path)
    return { admission: registerStartupBoardAdmission(tx), revision: next }
  }
  if (operator) throw new Error("Legacy enrollment cannot replace an existing authority revision")
  // A committed journal may be recovered, but arbitrary database bytes never
  // manufacture the independently retained current marker.
  if (!await publishCommittedMarker(path, revision) || !await boardGrantStillCurrent(tx, revision, path)) return null
  const next = randomUUID()
  await prepareGrantMarker(path, next)
  await tx.execute({ sql: "UPDATE board_access_epoch SET revision = ? WHERE singleton = 1 AND revision = ?", args: [next,revision] })
  return { admission: registerStartupBoardAdmission(tx), revision: next }
}

/** Called only by exclusive creation or independently verified offline operator enrollment. */
export async function prepareInitialBoardGrant(tx, markerPath) {
  if (await databaseRevision(tx)) throw new Error("Board continuity is already enrolled")
  rejectSymlinkPath(markerPath)
  if (lstatSync(markerPath, { throwIfNoEntry: false })) throw new Error("Board marker destination already exists")
  const directory = pendingDirectory(markerPath)
  rejectSymlinkPath(directory)
  if (lstatSync(directory, { throwIfNoEntry: false }) && (await readdir(directory)).length) throw new Error("Unresolved Board journal prevents initial enrollment")
  const revision = randomUUID()
  await prepareGrantMarker(markerPath, revision)
  try {
    await tx.execute({ sql: "INSERT INTO board_access_epoch(singleton, revision) VALUES (1, ?)", args: [revision] })
    return revision
  } catch (error) {
    await rm(pendingFile(markerPath, revision), { force: true }).catch(() => {})
    throw error
  }
}

export async function finalizeStartupBoardGrant(client, revision) {
  if (!revision) return
  // Re-read the marker on each database read attempt. Publication and mismatch
  // handling stay outside the bounded startup retry.
  const current = await inspectBoardGrantRevision(client, getBoardGrantPath(client), retryStartupLock)
  if (current !== revision) throw new Error("Board continuity publication is pending; governed access remains locked")
}
