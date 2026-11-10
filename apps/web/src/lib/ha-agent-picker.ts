/** Shared discovery UI. Never replace a saved agent with the implicit default. */
export async function fetchHaAgents(signal: AbortSignal): Promise<Array<{ id: string; name: string }>> {
  const response = await fetch("/api/ha/agents", { signal, cache: "no-store" })
  const data = await response.json()
  if (!response.ok) throw new Error(typeof data.error === "string" ? data.error : typeof data.detail === "string" ? data.detail : response.status === 403 ? "Assist requires an active Home Assistant administrator" : "Home Assistant agent discovery failed")
  if (!Array.isArray(data.agents) || data.agents.some((agent: unknown) => !agent || typeof agent !== "object"
    || typeof (agent as { id?: unknown }).id !== "string" || !(agent as { id: string }).id
    || typeof (agent as { name?: unknown }).name !== "string")) {
    throw new Error("Home Assistant returned an invalid agent list")
  }
  return [...new Map<string, { id: string; name: string }>(data.agents.map((agent: { id: string; name: string }) => [agent.id, agent])).values()]
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
