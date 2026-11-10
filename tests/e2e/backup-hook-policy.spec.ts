import { expect, test } from "@playwright/test"
import { isNativeBackupHook } from "../../apps/web/src/lib/backup-hook-policy"

const trust = Symbol.for("meitheal.trusted-socket-peer-header")

test("native backup transport requires wrapper-owned immediate-peer metadata, not forwarded identity", () => {
  const before = Reflect.get(globalThis, trust)
  const request = (headers: Record<string, string>, path = "/api/backup/prepare", method = "POST") => new Request(`http://localhost${path}`, { method, headers })
  try {
    Reflect.deleteProperty(globalThis, trust)
    expect(isNativeBackupHook(request({ "x-meitheal-socket-peer": "127.0.0.1" }))).toBe(false)
    Reflect.set(globalThis, trust, true)
    for (const peer of ["127.0.0.1", "::1", "::ffff:127.0.0.1", "172.30.32.1"]) {
      expect(isNativeBackupHook(request({ "x-meitheal-socket-peer": peer }))).toBe(true)
    }
    expect(isNativeBackupHook(request({ "x-forwarded-for": "127.0.0.1", "x-meitheal-socket-peer": "172.30.32.2" }))).toBe(false)
    expect(isNativeBackupHook(request({ "x-meitheal-socket-peer": "127.0.0.1", "x-remote-user-id": "member", "x-remote-user-groups": "system-users" }))).toBe(false)
    expect(isNativeBackupHook(request({ "x-meitheal-socket-peer": "127.0.0.1", "x-remote-user-id": "" }))).toBe(false)
    expect(isNativeBackupHook(request({ "x-meitheal-socket-peer": "127.0.0.1" }, "/api/settings"))).toBe(false)
    expect(isNativeBackupHook(request({ "x-meitheal-socket-peer": "127.0.0.1" }, "/api/backup/prepare", "GET"))).toBe(false)
  } finally {
    if (before === undefined) Reflect.deleteProperty(globalThis, trust)
    else Reflect.set(globalThis, trust, before)
  }
})
