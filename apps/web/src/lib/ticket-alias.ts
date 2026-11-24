import { normalizeTaskLocatorKey } from "./board-request-context"

/**
 * Short ticket links such as `/t/MTH-4` or `/mth-4` open the canonical ticket page.
 * The ticket page finds the owning Board from the key and applies normal access checks.
 */
export function ticketAliasTarget(value: string | undefined, search: string, ingressPath = ""): string | null {
  const key = value ? normalizeTaskLocatorKey(value) : null
  return key ? `${ingressPath}/tickets/${key}${search}` : null
}
