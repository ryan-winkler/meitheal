type HaAgent = { id: string; name: string }

function isHaAgent(value: unknown): value is HaAgent {
  if (!value || typeof value !== "object") return false
  const agent = value as Record<string, unknown>
  return typeof agent.id === "string" && agent.id.length > 0 && typeof agent.name === "string"
}

/** Shared discovery UI. Never replace a saved agent with the implicit default. */
export async function fetchHaAgents(signal: AbortSignal): Promise<HaAgent[]> {
  const response = await fetch("/api/ha/agents", { signal, cache: "no-store" })
  const data: unknown = await response.json().catch(() => null)
  const body = data && typeof data === "object" ? data as Record<string, unknown> : {}
  if (!response.ok) throw new Error(typeof body.error === "string" ? body.error : typeof body.detail === "string" ? body.detail : response.status === 403 ? "Assist requires an active Home Assistant administrator" : "Home Assistant agent discovery failed")
  const agents = body.agents
  if (!Array.isArray(agents) || !agents.every(isHaAgent)) {
    throw new Error("Home Assistant returned an invalid agent list")
  }
  return [...new Map<string, HaAgent>(agents.map(agent => [agent.id, agent])).values()]
}

export function renderHaAgentOptions(select: HTMLSelectElement, agents: Array<{ id: string; name: string }>, selected: string): boolean {
  const missing = Boolean(selected) && !agents.some(agent => agent.id === selected)
  select.replaceChildren(
    new Option(select.dataset.default ?? "Default Agent", ""),
    ...agents.map(agent => new Option(agent.name || agent.id, agent.id)),
    ...(missing ? [new Option(`${selected} (unavailable)`, selected)] : []),
  )
  const unavailable = select.options.item(select.options.length - 1)
  if (missing && unavailable) unavailable.dataset.unavailable = "true"
  select.value = selected
  select.dataset.agentUnavailable = String(missing)
  return missing
}
