/** Process-local startup capabilities: never serialized into the database or environment. */
const contexts = new WeakMap()
export const boardGrantPath = "/data/meitheal-board-grants.json"

export function registerBoardGrantContext(client, { markerPath = boardGrantPath, created = false } = {}) {
  if (!client[Symbol.for("meitheal.boardGrantClient")]) Object.defineProperty(client, Symbol.for("meitheal.boardGrantClient"), { value: client })
  contexts.set(client, { markerPath, created })
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
  const context = contexts.get(client)
  if (!context?.created) return false
  context.created = false
  return true
}
