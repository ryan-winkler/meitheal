import { supervisorFetch } from "./supervisor-fetch"

/** Stable Home Assistant panel path; never publish a Supervisor ingress session token. */
export async function homeAssistantWorkLink(boardId: string, taskId?: string): Promise<string | null> {
  if (!process.env.SUPERVISOR_TOKEN) return null
  try {
    const response = await supervisorFetch("/addons/self/info")
    if (!response?.ok) { await response?.body?.cancel().catch(() => {}); return null }
    const payload: unknown = await response.json()
    const data = payload && typeof payload === "object" && "data" in payload ? payload.data : null
    const slug = data && typeof data === "object" && "slug" in data ? data.slug : null
    if (typeof slug !== "string" || !/^[a-z0-9_-]{1,128}$/.test(slug)) return null
    const work = `/boards/${encodeURIComponent(boardId)}${taskId ? `?open=${encodeURIComponent(taskId)}` : ""}`
    return `/${slug}?meitheal=${encodeURIComponent(work)}`
  } catch { return null }
}
