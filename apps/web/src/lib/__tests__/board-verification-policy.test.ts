import { describe, it } from "node:test"
import assert from "node:assert/strict"
import {
  BOARD_VERIFICATION_HEADLINE,
  DEFAULT_BACKGROUND_POLL_INTERVAL_MS,
  DEFAULT_MIN_RECHECK_GAP_MS,
  DEFAULT_VISIBILITY_RETURN_GAP_MS,
  describeVerificationPause,
  shouldRunBackgroundRecheck,
} from "../board-verification-policy"
import {
  CARD_DENSITY_KEY,
  CARD_FIELD_PREFS_KEY,
  readCardDensity,
  readCardFieldPrefs,
} from "../card-view-sync"

describe("board-verification-policy", () => {
  it("preserves exact verification headline across all pause reasons", () => {
    const reasons = ["offline", "timeout", "server", "session"] as const
    for (const reason of reasons) {
      const copy = describeVerificationPause(reason)
      assert.equal(copy.title, BOARD_VERIFICATION_HEADLINE)
      assert.ok(copy.detail.length > 15)
    }
  })

  it("includes HTTP status code when server pause provides one", () => {
    const withStatus = describeVerificationPause("server", 503)
    assert.match(withStatus.detail, /HTTP 503/)

    const withoutStatus = describeVerificationPause("server")
    assert.doesNotMatch(withoutStatus.detail, /HTTP/)
  })

  it("provides distinct contextual details for offline vs timeout", () => {
    const offline = describeVerificationPause("offline")
    const timeout = describeVerificationPause("timeout")
    assert.notEqual(offline.detail, timeout.detail)
    assert.match(offline.detail, /offline/i)
    assert.match(timeout.detail, /timed out/i)
  })

  it("skips background recheck while document is hidden", () => {
    assert.equal(
      shouldRunBackgroundRecheck({
        now: 100_000,
        lastVerifiedAt: 0,
        isHidden: true,
        isDetached: true,
      }),
      false,
    )
  })

  it("always rechecks when visible and detached", () => {
    assert.equal(
      shouldRunBackgroundRecheck({
        now: 1_000,
        lastVerifiedAt: 999,
        isHidden: false,
        isDetached: true,
      }),
      true,
    )
  })

  it("enforces minimum recency gap when attached and visible", () => {
    assert.ok(DEFAULT_BACKGROUND_POLL_INTERVAL_MS >= 30_000)
    assert.ok(DEFAULT_MIN_RECHECK_GAP_MS >= 15_000)
    assert.ok(DEFAULT_VISIBILITY_RETURN_GAP_MS >= 10_000)

    assert.equal(
      shouldRunBackgroundRecheck({
        now: 50_000,
        lastVerifiedAt: 40_000,
        isHidden: false,
        isDetached: false,
        minGapMs: 20_000,
      }),
      false,
    )

    assert.equal(
      shouldRunBackgroundRecheck({
        now: 60_000,
        lastVerifiedAt: 40_000,
        isHidden: false,
        isDetached: false,
        minGapMs: 20_000,
      }),
      true,
    )
  })
})

describe("card-view-sync", () => {
  function mockStorage(entries: Record<string, string | null>) {
    return {
      getItem(key: string) {
        return Object.prototype.hasOwnProperty.call(entries, key) ? entries[key] : null
      },
    }
  }

  it("parses valid boolean field preferences and ignores non-boolean entries", () => {
    const storage = mockStorage({
      [CARD_FIELD_PREFS_KEY]: JSON.stringify({
        key: false,
        labels: true,
        priority: "yes",
        extra: 123,
      }),
    })
    assert.deepEqual(readCardFieldPrefs(storage), {
      key: false,
      labels: true,
    })
  })

  it("returns empty preferences on malformed JSON or arrays", () => {
    assert.deepEqual(readCardFieldPrefs(mockStorage({ [CARD_FIELD_PREFS_KEY]: "{bad" })), {})
    assert.deepEqual(readCardFieldPrefs(mockStorage({ [CARD_FIELD_PREFS_KEY]: "[1,2]" })), {})
    assert.deepEqual(readCardFieldPrefs(null), {})
  })

  it("validates card density and falls back to comfortable", () => {
    assert.equal(readCardDensity(mockStorage({ [CARD_DENSITY_KEY]: "compact" })), "compact")
    assert.equal(readCardDensity(mockStorage({ [CARD_DENSITY_KEY]: "spacious" })), "spacious")
    assert.equal(readCardDensity(mockStorage({ [CARD_DENSITY_KEY]: "ultra-wide" })), "comfortable")
    assert.equal(readCardDensity(null), "comfortable")
  })
})
