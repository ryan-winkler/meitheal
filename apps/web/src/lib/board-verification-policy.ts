/**
 * Board Verification Policy — Pure domain helper for board access verification UX
 *
 * @domain auth
 * @bounded-context boards (verification)
 *
 * Keeps fail-closed verification behavior predictable while explaining why a
 * verification check paused and avoiding excessive background polling.
 */

export type VerificationPauseReason = "offline" | "timeout" | "server" | "session"

export interface VerificationBannerCopy {
  title: string
  detail: string
}

export const BOARD_VERIFICATION_HEADLINE =
  "This Board is hidden until access can be verified. Your input is kept on this page."

export const DEFAULT_BACKGROUND_POLL_INTERVAL_MS = 30_000
export const DEFAULT_MIN_RECHECK_GAP_MS = 20_000
export const DEFAULT_VISIBILITY_RETURN_GAP_MS = 15_000

export function describeVerificationPause(
  reason: VerificationPauseReason,
  statusCode?: number,
): VerificationBannerCopy {
  switch (reason) {
    case "offline":
      return {
        title: BOARD_VERIFICATION_HEADLINE,
        detail: "You appear to be offline. Waiting for your connection to return so access can be verified automatically.",
      }
    case "timeout":
      return {
        title: BOARD_VERIFICATION_HEADLINE,
        detail: "The verification check timed out while reaching Meitheal or Home Assistant ingress. Retry when your connection stabilizes.",
      }
    case "server":
      return {
        title: BOARD_VERIFICATION_HEADLINE,
        detail: statusCode
          ? `The server temporarily returned HTTP ${statusCode}. Your unsaved edits remain safely on this page.`
          : "The server was temporarily unreachable. Your unsaved edits remain safely on this page.",
      }
    default:
      return {
        title: BOARD_VERIFICATION_HEADLINE,
        detail: "Access verification paused while reconnecting to your workspace. Retry to restore your Board view.",
      }
  }
}

export function shouldRunBackgroundRecheck(params: {
  now: number
  lastVerifiedAt: number
  isHidden: boolean
  isDetached: boolean
  minGapMs?: number
}): boolean {
  if (params.isHidden) return false
  if (params.isDetached) return true
  const minGap = params.minGapMs ?? DEFAULT_MIN_RECHECK_GAP_MS
  return params.now - params.lastVerifiedAt >= minGap
}
