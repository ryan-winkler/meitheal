import { getStatusDef, STATUS } from "../../../lib/status-config"

const terminalStatuses = [STATUS.COMPLETE, ...(getStatusDef(STATUS.COMPLETE)?.aliases ?? []), "archived"]

// Values come from the built-in workflow definitions, never from a request.
export const deferralTerminalStatusesSql = `(${terminalStatuses.map(status => `'${status}'`).join(", ")})`

export function isDeferralTerminalStatus(status: string): boolean {
  return terminalStatuses.includes(status.toLowerCase())
}
