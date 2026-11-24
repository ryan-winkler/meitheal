import { expect, type APIRequestContext } from "@playwright/test"
import { setTimeout } from "node:timers/promises"

/** Acquire the serving fixture's current proof for a caller that already owns this Board context. */
export async function currentBoardWriteHeaders(
  request: APIRequestContext,
  boardId: string,
  headers: Record<string, string>,
  ingress = "",
  retryRateLimit = false,
): Promise<Record<string, string>> {
  const url = ingress + "/api/boards"
  let directory = await request.get(url, { headers })
  if (retryRateLimit && directory.status() === 429) {
    const seconds = Number(directory.headers()["retry-after"] ?? 60)
    await directory.dispose()
    await setTimeout((Number.isFinite(seconds) ? Math.min(Math.max(seconds, 1), 61) : 60) * 1000)
    directory = await request.get(url, { headers })
  }
  expect(directory.status(), "Read the Board directory with the fixture actor").toBe(200)
  const session = directory.headers()["x-meitheal-board-session"]
  if (!session || !/^[a-f0-9]{64}$/.test(session)) throw new Error("Current Board session is unavailable")
  return { ...headers, "x-meitheal-board-id": boardId, "x-meitheal-board-session": session }
}
