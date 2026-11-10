import { recentActivityPersonKey, type RecentTaskActor } from "@domains/tasks/persistence/recent-activity"
import { verifiedIngressUser } from "./verified-ingress-user"

export function resolveRecentActivityActor(locals: App.Locals): RecentTaskActor {
  if (locals.agentToken) return { kind: "agent", personKey: null }
  const user = verifiedIngressUser(locals)
  if (user) return { kind: "human", personKey: recentActivityPersonKey(user.id) }
  return { kind: "system", personKey: null }
}
