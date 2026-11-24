import { currentTaskApiContext, type TaskApiContext } from "./task-api"
import { deleteVersionedTask, saveVersionedTask, sameTaskApiContext, taskRecordVersion } from "./task-api-client"
import { openTaskDetailHandoff } from "./task-detail-handoff"

export interface TableWriteIntent {
  id: string
  version: number | null
  context: TaskApiContext
  signal: AbortSignal
}
interface Proposal { fields: Record<string, unknown>; title: string; failed: boolean; deleting?: boolean }

/** Row presentation state around the existing canonical versioned Task client. */
export function createTableTaskWrites(table: HTMLTableElement, signal: AbortSignal, review: () => void) {
  let context = currentTaskApiContext()
  let verification = new AbortController()
  let withheld = false
  let revoked = false
  const proposals = new Map<string, Proposal>()
  const queues = new Map<string, Promise<unknown>>()
  const rowFor = (id: string) => table.querySelector<HTMLElement>(`.table-row[data-id="${CSS.escape(id)}"]`)
  const sameOwner = () => {
    const now = currentTaskApiContext()
    return Boolean(context && now && context.boardId === now.boardId && context.actorKey === now.actorKey)
  }
  const clear = () => { proposals.clear(); document.getElementById("table-pending-edits")?.remove() }
  function render() {
    document.getElementById("table-pending-edits")?.remove()
    if (!sameOwner()) { clear(); return }
    if (withheld || revoked || signal.aborted) return
    const failed = [...proposals].filter(([, value]) => value.failed)
    if (!failed.length) return
    const panel = document.createElement("section")
    panel.id = "table-pending-edits"
    panel.className = "alert alert-warning"
    panel.setAttribute("role", "alert")
    panel.append("Some changes could not be confirmed. Your input is kept here. Review the saved task before making further changes.")
    for (const [id, proposal] of failed) {
      const line = document.createElement("p")
      const fields = Object.entries(proposal.fields).map(([field, value]) => `${field === "area_id" ? "Area" : field}: ${value ?? "Unfiled"}`).join(" · ")
      line.append(`${proposal.title} — ${proposal.deleting ? "Deletion not confirmed" : fields} `)
      const open = document.createElement("button")
      open.type = "button"
      open.className = "btn btn-ghost"
      open.textContent = "Review saved task"
      open.addEventListener("click", () => openTaskDetailHandoff(id), { signal })
      const discard = document.createElement("button")
      discard.type = "button"
      discard.className = "btn btn-ghost"
      discard.textContent = "Discard proposed changes and reload"
      discard.addEventListener("click", () => { proposals.delete(id); render(); review() }, { signal })
      line.append(open, " ", discard)
      panel.append(line)
    }
    table.before(panel)
  }
  function restore() {
    if (!sameOwner()) { clear(); return }
    for (const [id, proposal] of proposals) {
      const row = rowFor(id)
      if (!row) continue
      for (const [field, value] of Object.entries(proposal.fields)) {
        if (field === "title") {
          const title = row.querySelector<HTMLElement>(".editable-cell")
          if (title) title.textContent = String(value ?? "")
        } else {
          const select = row.querySelector<HTMLSelectElement>(`select[data-field="${CSS.escape(field)}"]`)
          if (select) select.value = String(value ?? "")
        }
      }
    }
    render()
  }
  function capture(row: HTMLElement): TableWriteIntent | undefined {
    if (withheld || revoked || signal.aborted || !context || !sameTaskApiContext(context, currentTaskApiContext()) || !row.dataset.id) return
    return { id: row.dataset.id, version: taskRecordVersion({ task_version: row.dataset.taskVersion }), context,
      signal: AbortSignal.any([signal, verification.signal]) }
  }
  function current(intent: TableWriteIntent) {
    return !withheld && !revoked && !intent.signal.aborted && sameTaskApiContext(intent.context, currentTaskApiContext())
  }
  function proposalFor(row: HTMLElement) {
    const id = row.dataset.id!
    let value = proposals.get(id)
    if (!value) {
      value = { fields: {}, title: row.querySelector<HTMLElement>(".editable-cell")?.dataset.original ?? row.dataset.title ?? "Task", failed: false }
      proposals.set(id, value)
    }
    return value
  }
  async function edit(row: HTMLElement, fields: Record<string, unknown>) {
    const id = row.dataset.id
    if (!id || revoked || !sameOwner()) return null
    const proposal = proposalFor(row)
    Object.assign(proposal.fields, fields)
    const prior = queues.get(id) ?? Promise.resolve()
    const queued = prior.then(async () => {
      if (proposal.failed || proposals.get(id) !== proposal) { restore(); return null }
      const intent = capture(rowFor(id) ?? row)
      if (!intent) { proposal.failed = true; restore(); return null }
      const saved = await saveVersionedTask(id, fields, intent.version, intent.context, intent.signal)
      if (saved.ok && current(intent)) {
        const liveRow = rowFor(id) ?? row
        liveRow.dataset.taskVersion = String(saved.version)
        for (const [field, value] of Object.entries(fields)) if (proposal.fields[field] === value) delete proposal.fields[field]
        if (!Object.keys(proposal.fields).length) proposals.delete(id)
        restore()
        return saved.task
      }
      if (!revoked && sameOwner()) { proposal.failed = true; restore() }
      else if (!sameOwner()) clear()
      return null
    })
    queues.set(id, queued)
    try { return await queued } finally { if (queues.get(id) === queued) queues.delete(id) }
  }
  async function remove(row: HTMLElement, intent: TableWriteIntent) {
    if (!current(intent) || proposals.has(intent.id)) return false
    const proposal = proposalFor(row)
    proposal.deleting = true
    const result = await deleteVersionedTask(intent.id, intent.version, intent.context, intent.signal)
    if (result.ok && current(intent)) { proposals.delete(intent.id); render(); return true }
    if (!revoked && sameOwner()) { proposal.failed = true; render() }
    else if (!sameOwner()) clear()
    return false
  }
  document.addEventListener("meitheal:board-hidden", () => {
    withheld = true; verification.abort(); document.getElementById("table-pending-edits")?.remove()
  }, { signal })
  document.addEventListener("meitheal:board-revoked", event => {
    const boardId = (event as CustomEvent<{ boardId?: string }>).detail?.boardId
    if (boardId && boardId !== context?.boardId) return
    revoked = true; verification.abort(); clear()
  }, { signal })
  document.addEventListener("meitheal:board-verified", () => {
    if (revoked || !sameOwner()) { clear(); return }
    context = currentTaskApiContext(); withheld = false; verification = new AbortController(); restore()
  }, { signal })
  signal.addEventListener("abort", () => { verification.abort(); clear() }, { once: true })
  return { capture, current, edit, remove, restore, hasPending: () => proposals.size > 0 }
}
export type TableTaskWrites = ReturnType<typeof createTableTaskWrites>
