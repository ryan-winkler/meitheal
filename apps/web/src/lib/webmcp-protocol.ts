/** Browser tools are opt-in; unknown or missing settings fail closed. */
export const WEBMCP_SETTING = "agent-protocols-webmcp-enabled"

export function webMcpEnabled(value: unknown): boolean {
  return value === true || value === "true"
}
