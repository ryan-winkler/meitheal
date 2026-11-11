/** The HA command includes conversation entities and legacy config-entry agents. */
export interface ConversationAgent {
  id: string
  name: string
  supported_languages?: string[] | "*"
}

export function readConversationAgents(result: unknown): ConversationAgent[] {
  if (!result || typeof result !== "object" || !Array.isArray((result as { agents?: unknown }).agents)) {
    throw new Error("Home Assistant did not return its conversation agent list")
  }
  const agents = new Map<string, ConversationAgent>()
  for (const value of (result as { agents: unknown[] }).agents) {
    if (!value || typeof value !== "object") throw new Error("Invalid Home Assistant conversation agent")
    const agent = value as Partial<ConversationAgent>
    if (typeof agent.id !== "string" || !agent.id.trim() || typeof agent.name !== "string"
      || !(agent.supported_languages === undefined || agent.supported_languages === "*" || (Array.isArray(agent.supported_languages)
        && agent.supported_languages.every(language => typeof language === "string")))) {
      throw new Error("Invalid Home Assistant conversation agent")
    }
    agents.set(agent.id, { id: agent.id, name: agent.name.trim() || agent.id,
      ...(agent.supported_languages === undefined ? {} : { supported_languages: agent.supported_languages }),
    })
  }
  return [...agents.values()]
}
