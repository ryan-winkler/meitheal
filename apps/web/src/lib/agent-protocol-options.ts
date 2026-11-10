export const AGENT_PROTOCOLS = ["a2a", "mcp", "webmcp"] as const

export type AgentProtocol = typeof AGENT_PROTOCOLS[number]

export const AGENT_PROTOCOL_DEFAULTS: Record<AgentProtocol, boolean> = {
  a2a: true,
  mcp: true,
  webmcp: false,
}

export function agentProtocolSettingKey(protocol: AgentProtocol): string {
  return `agent-protocols-${protocol}-enabled`
}

export function agentProtocolEnabled(protocol: AgentProtocol, value: unknown): boolean {
  if (value == null) return AGENT_PROTOCOL_DEFAULTS[protocol]
  return value === true || value === "true"
}
