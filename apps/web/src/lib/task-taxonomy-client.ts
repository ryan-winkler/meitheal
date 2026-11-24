/**
 * Shared client helpers for loading pillar principles in task modals.
 * @domain tasks
 */

export function formatPrincipleOptionLabel(
  principle: { statement?: unknown; description?: unknown; id?: unknown },
  maxLength = 40,
): string {
  const raw = String(principle.statement ?? principle.description ?? principle.id ?? "").trim()
  if (raw.length <= maxLength) return raw
  return `${raw.slice(0, maxLength - 3)}...`
}

export async function loadPillarPrinciplesOptions(
  select: HTMLSelectElement | null,
  pillarId: string | null | undefined,
  options: {
    signal: AbortSignal
    headers?: HeadersInit
    selectedId?: string
    emptyLabel?: string
    truncate?: number
    onError?: (err: unknown) => void
  },
): Promise<void> {
  if (!select) return
  const emptyOpt = select.options[0]
    ? new Option(select.options[0].textContent || options.emptyLabel || "No principle", "")
    : new Option(options.emptyLabel || "No principle", "")
  select.replaceChildren(emptyOpt)
  const trimmedPillarId = typeof pillarId === "string" ? pillarId.trim() : ""
  if (!trimmedPillarId || trimmedPillarId === "null" || trimmedPillarId === "undefined") {
    select.value = ""
    return
  }
  try {
    const res = await fetch(`/api/pillars/${encodeURIComponent(trimmedPillarId)}/principles`, { // nosemgrep
      signal: options.signal,
      ...(options.headers ? { headers: options.headers } : {}),
    })
    if (!res.ok || options.signal.aborted) return
    const data = await res.json().catch(() => null) as { principles?: unknown } | Array<Record<string, unknown>> | null
    const list = Array.isArray(data) ? data : Array.isArray(data?.principles) ? data.principles : []
    for (const item of list as Array<{ id?: unknown; statement?: unknown; description?: unknown }>) {
      if (!item?.id) continue
      const label = options.truncate
        ? formatPrincipleOptionLabel(item, options.truncate)
        : String(item.statement ?? item.description ?? item.id)
      select.append(new Option(label, String(item.id)))
    }
    if (options.selectedId) select.value = options.selectedId
  } catch (err) {
    if (!(err instanceof DOMException && err.name === "AbortError")) {
      options.onError?.(err)
    }
  }
}
