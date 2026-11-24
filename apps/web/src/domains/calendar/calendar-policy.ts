/** Settings rows may contain serialized JSON or legacy plain text. */
export function decodeCalendarSetting(raw?: string): unknown {
  if (raw === undefined) return undefined
  try { return JSON.parse(raw) } catch { return raw }
}

export function ticketDetailsEnabled(raw?: string): boolean {
  const value = decodeCalendarSetting(raw)
  return value !== false && value !== "false"
}
