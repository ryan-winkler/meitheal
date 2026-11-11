export const activeParticipantProblemType = "https://meitheal.local/problems/active-task-participant-required"
export const activeParticipantMessage = "Home Assistant could not verify your active account. Reopen Meitheal from Home Assistant and try again."

export async function isActiveParticipantProblem(response: Response): Promise<boolean> {
  if (response.status !== 403) return false
  const contentType = response.headers.get("content-type") ?? ""
  if (!contentType.includes("application/problem+json")) {
    // Supervisor may deny a stale ingress session before Meitheal sees it.
    return !response.headers.has("x-ingress-path") && !/\bjson\b/i.test(contentType)
      && Boolean(response.url && new URL(response.url).pathname.startsWith("/api/hassio_ingress/"))
  }
  try {
    const problem: unknown = await response.json()
    return Boolean(problem && typeof problem === "object" && "type" in problem && problem.type === activeParticipantProblemType)
  } catch {
    return false
  }
}
