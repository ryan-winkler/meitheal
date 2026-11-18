/** Legacy shared-work surfaces. Named Board and recovery routes remain available. */
export function householdWorkRoute(path: string, method: string): boolean {
  if (path === "/api/goals" && (method === "GET" || method === "HEAD")) return false
  if (path === "/api/boards/household") return method === "GET" || method === "HEAD"
  if (/^\/boards\/household(?:\/|$)/.test(path)) return true
  if (/^\/(?:tasks|calendar|areas|projects|goals|habits|routines|planning|timeline|eisenhower|triage|deferred|inactivity|review|pinned|inbox)(?:\/|$)/.test(path)) return true
  return /^\/api\/(?:tasks|lanes|areas|projects|goals|habits|routines|calendar|review|briefing|daily-briefing|task-inactivity|inactivity|stalls|drafts|task-drafts|triage|v1)(?:\/|$)/.test(path) ||
    /^\/api\/export\/(?:tasks|calendar)/.test(path)
}
