import { describe, it, before, after } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// Isolate SQLite persistence to a temporary directory before importing DB modules
const tempDir = mkdtempSync(join(tmpdir(), "meitheal-ha-cache-test-"))
process.env.MEITHEAL_DB_URL = `file:${join(tempDir, "test.db")}`
process.env.MEITHEAL_BOARD_GRANT_PATH = join(tempDir, "meitheal-board-grants.json")

describe("HA user cache, ingress display name, and profile sanitization", () => {
  let cacheMod: typeof import("./ha-user-cache")
  let ingressMod: typeof import("../auth/ingress")
  let profileMod: typeof import("../auth/user-profile")

  before(async () => {
    cacheMod = await import("./ha-user-cache")
    ingressMod = await import("../auth/ingress")
    profileMod = await import("../auth/user-profile")
  })

  after(() => {
    cacheMod?.resetHAUserCacheForTests()
    rmSync(tempDir, { recursive: true, force: true })
  })

  it("detects raw 32-char hex HA user IDs and sanitizes display names", () => {
    assert.equal(cacheMod.isRawHAUserId("71f63692cd804318894e100bf097c1e9"), true)
    assert.equal(cacheMod.isRawHAUserId("Ryan Winkler"), false)
    assert.equal(cacheMod.isRawHAUserId("ryan"), false)
    assert.equal(cacheMod.sanitizeDisplayName("  <b>Ryan</b>\u0007  "), "Ryan")
    assert.equal(cacheMod.sanitizeDisplayName(""), null)
  })

  it("extracts HA display name and username from ingress headers", () => {
    const headers = new Headers({
      "x-ingress-path": "/api/hassio_ingress/abc123",
      "x-remote-user-id": "71f63692cd804318894e100bf097c1e9",
      "x-remote-user-display-name": "Ryan Winkler",
      "x-remote-user-name": "ryan",
      "x-remote-user-groups": "system-admin,system-users",
    })
    const ctx = ingressMod.resolveIngressContext(headers, {
      peer: "172.30.32.2",
      fromSupervisor: true,
      identityHeadersSafe: true,
      configuredPath: undefined,
    })
    assert.equal(ctx.behindIngress, true)
    assert.equal(ctx.hassUserId, "71f63692cd804318894e100bf097c1e9")
    assert.equal(ctx.hassDisplayName, "Ryan Winkler")
    assert.equal(ctx.hassUserName, "ryan")
    assert.equal(ctx.hassIsAdmin, true)
  })

  it("rejects raw 32-char hex HA IDs in user profile normalization", () => {
    const rawHex = "71f63692cd804318894e100bf097c1e9"
    const normalized = profileMod.normalizeUserProfile(
      { displayName: rawHex, username: rawHex, role: "Admin" },
      { displayName: "Ryan Winkler", username: "ryan", role: "Admin" },
    )
    assert.equal(normalized.displayName, "Ryan Winkler")
    assert.equal(normalized.username, "ryan")

    const fallbackOnlyHex = profileMod.normalizeUserProfile(
      { displayName: rawHex, username: rawHex },
      { displayName: rawHex, username: rawHex, role: "Admin" },
    )
    assert.equal(fallbackOnlyHex.displayName, "Household Member")
    assert.equal(fallbackOnlyHex.username, "householdmember")
  })

  it("caches Core users, enforces revocations strictly, and isolates fingerprints", async () => {
    cacheMod.resetHAUserCacheForTests()
    const fpA = cacheMod.currentSupervisorFingerprint("token-ha-instance-a")!
    const fpB = cacheMod.currentSupervisorFingerprint("token-ha-instance-b")!
    const now = 1_700_000_000_000

    const synced = await cacheMod.syncHAUserCacheFromCore(
      [
        {
          id: "71f63692cd804318894e100bf097c1e9",
          name: "Ryan Winkler",
          username: "ryan",
          is_active: true,
          is_owner: true,
          system_generated: false,
          group_ids: ["system-admin"],
        },
        {
          id: "revoked0000000000000000000000001",
          name: "Old Guest",
          username: "guest",
          is_active: false,
          is_owner: false,
          system_generated: false,
          group_ids: ["system-users"],
        },
      ],
      fpA,
      now,
    )
    assert.equal(synced, true)

    // Fresh memory hit within 60s
    assert.equal(cacheMod.readFreshCachedHARole("71f63692cd804318894e100bf097c1e9", fpA, now + 5_000), "admin")
    assert.equal(cacheMod.readFreshCachedHARole("revoked0000000000000000000000001", fpA, now + 5_000), "denied")
    assert.equal(cacheMod.getCachedHAUserDisplayNameSync("71f63692cd804318894e100bf097c1e9", fpA), "Ryan Winkler")

    // Different HA instance fingerprint must NOT inherit cached roles
    assert.equal(cacheMod.readFreshCachedHARole("71f63692cd804318894e100bf097c1e9", fpB, now + 5_000), null)

    // Simulate process restart (clear memory) -> SQLite outage fallback still serves active user and denies revoked user
    cacheMod.resetHAUserCacheForTests()
    assert.equal(await cacheMod.readOutageCachedHARole("71f63692cd804318894e100bf097c1e9", fpA, now + 120_000), "admin")
    assert.equal(await cacheMod.readOutageCachedHARole("revoked0000000000000000000000001", fpA, now + 120_000), "denied")

    // Trusted ingress bootstrap MUST NOT revive an explicitly revoked user
    const revived = await cacheMod.cacheTrustedIngressUser({
      userId: "revoked0000000000000000000000001",
      displayName: "Sneaky Guest",
      isAdmin: true,
      fingerprint: fpA,
      now: now + 130_000,
    })
    assert.equal(revived, null)
    assert.equal(await cacheMod.readOutageCachedHARole("revoked0000000000000000000000001", fpA, now + 131_000), "denied")

    // Trusted ingress bootstrap works for a brand new user when Core is unreachable
    const bootstrapped = await cacheMod.cacheTrustedIngressUser({
      userId: "fresh000000000000000000000000002",
      displayName: "Alex Rivera",
      username: "alex",
      isAdmin: false,
      fingerprint: fpA,
      now: now + 135_000,
    })
    assert.equal(bootstrapped?.role, "member")
    assert.equal(bootstrapped?.displayName, "Alex Rivera")
    const resolved = await cacheMod.resolveCachedHAUserDisplayName("fresh000000000000000000000000002", fpA)
    assert.equal(resolved?.displayName, "Alex Rivera")
  })
})
