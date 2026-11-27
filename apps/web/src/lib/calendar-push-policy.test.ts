import { describe, it } from "node:test"
import assert from "node:assert/strict"
import {
  describeManualCalendarPushState,
  isAutomaticBidirectionalCalendarSync,
  shouldShowManualCalendarPush,
} from "./calendar-push-policy"

describe("calendar push visibility policy", () => {
  it("shows manual push by default when settings are empty or sync is off", () => {
    assert.equal(shouldShowManualCalendarPush(undefined), true)
    assert.equal(shouldShowManualCalendarPush({}), true)
    assert.equal(
      shouldShowManualCalendarPush({
        calendar_sync_enabled: "false",
        calendar_sync_mode: "bidirectional",
        calendar_sync_interval_ms: "300000",
      }),
      true,
    )
  })

  it("hides manual push when explicitly disabled in settings", () => {
    assert.equal(
      shouldShowManualCalendarPush({
        calendar_manual_push_enabled: false,
        calendar_sync_enabled: "false",
      }),
      false,
    )
    assert.equal(
      shouldShowManualCalendarPush({
        calendar_manual_push_enabled: "false",
        calendar_sync_enabled: "true",
        calendar_sync_interval_ms: "0",
      }),
      false,
    )
  })

  it("hides manual push when automatic bidirectional sync with write-back is active", () => {
    const autoBidi = {
      calendar_manual_push_enabled: true,
      calendar_sync_enabled: "true",
      calendar_sync_mode: "bidirectional",
      calendar_write_back: true,
      calendar_sync_interval_ms: "300000",
    }
    assert.equal(isAutomaticBidirectionalCalendarSync(autoBidi), true)
    assert.equal(shouldShowManualCalendarPush(autoBidi), false)
    assert.equal(describeManualCalendarPushState(autoBidi).visible, false)
  })

  it("shows manual push when sync is manual (interval 0), import-only, or write-back is off", () => {
    assert.equal(
      shouldShowManualCalendarPush({
        calendar_manual_push_enabled: true,
        calendar_sync_enabled: "true",
        calendar_sync_mode: "bidirectional",
        calendar_write_back: true,
        calendar_sync_interval_ms: "0",
      }),
      true,
    )
    assert.equal(
      shouldShowManualCalendarPush({
        calendar_manual_push_enabled: true,
        calendar_sync_enabled: "true",
        calendar_sync_mode: "import",
        calendar_write_back: true,
        calendar_sync_interval_ms: "300000",
      }),
      true,
    )
    assert.equal(
      shouldShowManualCalendarPush({
        calendar_manual_push_enabled: true,
        calendar_sync_enabled: "true",
        calendar_sync_mode: "bidirectional",
        calendar_write_back: false,
        calendar_sync_interval_ms: "300000",
      }),
      true,
    )
  })
})
