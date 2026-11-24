/** Process-local startup capabilities: never serialized into the database or environment. */
const contexts = new WeakMap()
const preparedGrantMarkers = new WeakMap()
export const boardGrantPath = "/data/meitheal-board-grants.json"
export const boardGrantRevisionQuery = "SELECT revision FROM board_access_epoch WHERE singleton = 1"

export function registerBoardGrantContext(client, { markerPath = boardGrantPath, created = false, pre0016LocalUpgrade = false } = {}) {
  if (!client[Symbol.for("meitheal.boardGrantClient")]) Object.defineProperty(client, Symbol.for("meitheal.boardGrantClient"), { value: client })
  contexts.set(client, { markerPath, created, pre0016LocalUpgrade })
}

export function getBoardGrantPath(client) {
  client = unwrapBoardGrantClient(client)
  return contexts.get(client)?.markerPath ?? boardGrantPath
}

export function unwrapBoardGrantClient(client) {
  const seen = new Set()
  while (client) {
    if (seen.has(client)) throw new Error("Cyclic Board continuity client context")
    seen.add(client)
    const next = client[Symbol.for("meitheal.boardGrantClient")]
    if (!next || next === client) return client
    client = next
  }
  return client
}

export function consumeDatabaseCreation(client) {
  client = unwrapBoardGrantClient(client)
  const context = contexts.get(client)
  if (!context?.created) return false
  context.created = false
  return true
}

export function hasPre0016LocalUpgrade(client) {
  client = unwrapBoardGrantClient(client)
  return Boolean(contexts.get(client)?.pre0016LocalUpgrade)
}

export function consumePre0016LocalUpgrade(client) {
  client = unwrapBoardGrantClient(client)
  const context = contexts.get(client)
  if (!context?.pre0016LocalUpgrade) return false
  context.pre0016LocalUpgrade = false
  return true
}

export function registerPreparedGrantMarker(tx, pendingPath, revision, client) {
  if (tx && typeof tx === "object") preparedGrantMarkers.set(tx, { pendingPath, revision, client })
}

export function consumePreparedGrantMarker(tx) {
  const entry = preparedGrantMarkers.get(tx)
  if (!entry) return null
  preparedGrantMarkers.delete(tx)
  return entry
}
