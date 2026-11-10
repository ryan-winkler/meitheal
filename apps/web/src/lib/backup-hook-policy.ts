const SOCKET_PEER_HEADER = "x-meitheal-socket-peer"
const SOCKET_PEER_TRUST = Symbol.for("meitheal.trusted-socket-peer-header")
const NATIVE_PEERS = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1", "172.30.32.1", "::ffff:172.30.32.1"])

/** Read only wrapper-overwritten provenance; never substitute clientAddress/XFF. */
export function getTrustedSocketPeer(request: Request): string | undefined {
  if (Reflect.get(globalThis, SOCKET_PEER_TRUST) !== true) return undefined
  return request.headers.get(SOCKET_PEER_HEADER) || undefined
}

/** Only serve.mjs may supply this metadata; forwarded client-address headers are not trusted. */
export function isNativeBackupHook(request: Request): boolean {
  if (request.method !== "POST") return false
  const path = new URL(request.url).pathname
  if (path !== "/api/backup/prepare" && path !== "/api/backup/complete") return false
  if (["x-remote-user-id", "x-remote-user-name", "x-remote-user-display-name", "x-remote-user-groups", "x-hass-user-id"].some(header => request.headers.has(header))) return false
  return NATIVE_PEERS.has(getTrustedSocketPeer(request) ?? "")
}
