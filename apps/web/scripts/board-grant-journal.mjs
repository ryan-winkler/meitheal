import { randomUUID } from "node:crypto"
import { constants, lstatSync } from "node:fs"
import { mkdir, open, readdir, rename, rm } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { acquireWriteTransaction } from "./database-client.mjs"
import { boardGrantPath, consumeDatabaseCreation, getBoardGrantPath, unwrapBoardGrantClient } from "./board-grant-context.mjs"
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

export async function readBoardGrantRevision(path = boardGrantPath) {
  try {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      const stats = await file.stat()
      if (!stats.isFile() || stats.size > 160) return null
      const bytes = Buffer.alloc(161)
      const { bytesRead } = await file.read(bytes, 0, bytes.length, 0)
      if (bytesRead !== stats.size) return null
      const revision = JSON.parse(bytes.toString("utf8", 0, bytesRead))?.epoch
      return typeof revision === "string" && revisionPattern.test(revision) ? revision : null
    } finally { await file.close() }
  } catch { return null }
}

export async function databaseRevision(db) {
  db = unwrapBoardGrantClient(db)
  const { rows: [current] } = await db.execute("SELECT revision FROM board_access_epoch WHERE singleton = 1")
  return typeof current?.revision === "string" && revisionPattern.test(current.revision) ? current.revision : null
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

export async function currentBoardGrantRevision(db, path = getBoardGrantPath(db)) {
  db = unwrapBoardGrantClient(db)
  const marker = await readBoardGrantRevision(path)
  const revision = await databaseRevision(db)
  if (revision === marker) return revision
  if (!revision || await readBoardGrantRevision(pendingFile(path, revision)) !== revision) return null
  const tx = await acquireWriteTransaction(db)
  try {
    if (await databaseRevision(tx) !== revision) return null
    return await publishCommittedMarker(path, revision) ? revision : null
  } finally { tx.close() }
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
  if (await currentBoardGrantRevision(client) !== revision) throw new Error("Board continuity publication is pending; governed access remains locked")
}
