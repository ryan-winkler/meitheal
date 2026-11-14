import { checkProtocolAvailability } from "./protocol-availability"

const SETTING = "agent-protocols-a2a-enabled"
export const A2A_RESPONSE_HEADERS = { "Cache-Control": "private, no-store" }

export async function checkA2aAvailability(): Promise<Response | null> {
  return checkProtocolAvailability(SETTING, "A2A", A2A_RESPONSE_HEADERS)
}
