import type { InactivityFilter, InactivityScope, TaskInactivityRepository } from "@domains/tasks/persistence/task-inactivity-repository"

type PreviewData = Awaited<ReturnType<TaskInactivityRepository["preview"]>>
type Policy = PreviewData["policy"]
export type InactivityPreview = PreviewData & { now: number; canSave: boolean }

interface BoardCues {
  now: number
  cues: Record<string, number>
}

type PreviewRequest = { action: "preview"; areaId: InactivityScope; page: number; filter: InactivityFilter; days?: number }
type SaveRequest = { action: "save"; areaId: InactivityScope; days: number; expectedRevision: string | null;
  expectedDefaultRevision: string | null; areaGeneration: string | null; expectedAreaCatalogRevision: string | null }
type BoardRequest = { action: "board"; ids: string[] }

export class InactivityRequestError extends Error {
  constructor(readonly status: number) {
    super("Inactivity request failed")
  }
}

export function requestInactivity(action: PreviewRequest, signal: AbortSignal): Promise<InactivityPreview>
export function requestInactivity(action: SaveRequest, signal: AbortSignal): Promise<{ policy: Policy }>
export function requestInactivity(action: BoardRequest, signal: AbortSignal): Promise<BoardCues>
export async function requestInactivity(action: PreviewRequest | SaveRequest | BoardRequest, signal: AbortSignal) {
  const response = await fetch("/api/task-inactivity", {
    method: "POST",
    mode: "same-origin",
    redirect: "error",
    cache: "no-store",
    referrerPolicy: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(action),
    signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
  })
  if (!response.ok) throw new InactivityRequestError(response.status)
  if (!response.headers.get("cache-control")?.includes("no-store")) throw new InactivityRequestError(503)
  return response.json()
}
