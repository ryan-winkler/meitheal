import { isActiveParticipantProblem } from "@lib/task-participant-problem"
import { createSpriteIconElement } from "../../generated/icon-registry"

interface Reaction {
  id: number
  content: string
  author: string
  can_manage: boolean
}

interface ReactionGroup {
  content: string
  count: number
  reacted: boolean
  my_reaction_id: number | null
}

interface ReactionPage {
  reactions: Reaction[]
  groups?: ReactionGroup[]
  next_cursor: string | null
  can_react: boolean
}

export function mountReactions(host: HTMLElement, url: string, signal: AbortSignal, taskId?: string): void {
  const template = document.querySelector<HTMLTemplateElement>("#td-reaction-controls")
  if (!template || signal.aborted) return

  const isTaskLevel = taskId !== undefined
  const bar = document.createElement("div")
  bar.className = isTaskLevel ? "td-reaction-bar td-reaction-bar--task" : "td-reaction-bar td-reaction-bar--comment"

  const inlineGroups = document.createElement("div")
  inlineGroups.dataset.reactionGroups = ""
  inlineGroups.className = "td-reaction-chips"
  inlineGroups.hidden = true

  const panel = document.createElement("details")
  panel.className = isTaskLevel ? "td-reaction-details td-reaction-details--task" : "td-reaction-details td-reaction-details--comment"
  panel.dataset.reactionPanel = isTaskLevel ? "task" : "comment"

  const summary = document.createElement("summary")
  summary.className = "td-reaction-trigger"
  summary.title = isTaskLevel ? "Add or change your reaction (1 per person)" : "React to comment (1 per person)"
  const icon = createSpriteIconElement("mood-smile", { size: 15 })
  const label = document.createElement("span")
  label.className = "td-reaction-trigger__label"
  label.textContent = (isTaskLevel ? template.dataset.taskLabel : template.dataset.commentLabel) ?? (isTaskLevel ? "React" : "React")
  summary.append(icon, label)
  panel.append(summary)

  bar.append(inlineGroups, panel)
  host.append(bar)

  let initialized = false
  let controller: ReturnType<typeof initReactionPanel> | null = null
  const ensureInit = (fetchNow = true) => {
    if (initialized || !panel.isConnected) return controller
    initialized = true
    controller = initReactionPanel(panel, summary, inlineGroups, template, url, signal, taskId, fetchNow)
    return controller
  }

  panel.addEventListener("toggle", () => {
    if (!panel.open || !panel.isConnected) return
    if (!initialized) ensureInit(true)
    else controller?.reload()
  }, { signal })

  // Close popover when clicking outside so reactions feel lightweight and native.
  document.addEventListener("click", (event) => {
    if (!panel.open || !panel.isConnected) return
    if (!bar.contains(event.target as Node)) panel.open = false
  }, { signal })

  if (isTaskLevel) {
    // Eagerly hydrate task reactions so active chips appear directly in the conversation header.
    ensureInit(true)

    const emojiBtn = document.getElementById("td-chat-emoji-btn")
    emojiBtn?.addEventListener("click", () => {
      panel.open = !panel.open
      if (panel.open) {
        ensureInit(true)
        panel.scrollIntoView({ block: "nearest", behavior: "smooth" })
      }
    }, { signal })
  }
}

function initReactionPanel(
  panel: HTMLDetailsElement,
  summary: HTMLElement,
  groupsBar: HTMLElement,
  template: HTMLTemplateElement,
  url: string,
  signal: AbortSignal,
  taskId: string | undefined,
  fetchNow: boolean,
) {
  panel.append(template.content.cloneNode(true))
  const labels = template.dataset
  const status = panel.querySelector<HTMLElement>("[data-reaction-status]")!
  const error = panel.querySelector<HTMLElement>("[data-reaction-error]")!
  const list = panel.querySelector<HTMLUListElement>("[data-reaction-list]")!
  const retry = panel.querySelector<HTMLButtonElement>("[data-reaction-retry]")!
  const newest = panel.querySelector<HTMLButtonElement>("[data-reaction-newest]")!
  const older = panel.querySelector<HTMLButtonElement>("[data-reaction-older]")!
  const form = panel.querySelector<HTMLFormElement>("[data-reaction-form]")!
  const input = form.querySelector<HTMLInputElement>("input")!
  const quickEmojiBtns = Array.from(form.querySelectorAll<HTMLButtonElement>("[data-reaction-emoji]"))
  let busy = false
  let pageCursor: string | null = null
  let retryCursor: string | null = null
  let nextCursor: string | null = null
  let myReaction: { id: number; content: string } | null = null

  const isCurrent = () => !signal.aborted && panel.isConnected

  function setBusy(value: boolean): void {
    busy = value
    list.setAttribute("aria-busy", String(value))
    input.readOnly = value
  }

  function syncQuickEmojiHighlights(): void {
    for (const btn of quickEmojiBtns) {
      const emoji = btn.dataset.reactionEmoji ?? ""
      const isMine = myReaction !== null && myReaction.content === emoji
      btn.setAttribute("aria-pressed", String(isMine))
      btn.classList.toggle("is-active", isMine)
    }
  }

  function render(reaction: Reaction): HTMLLIElement {
    const row = document.createElement("li")
    row.className = "td-reaction-row"
    const content = document.createElement("bdi")
    content.className = "td-reaction-row__emoji"
    content.textContent = reaction.content
    const author = document.createElement("bdi")
    author.className = "td-reaction-row__author"
    author.textContent = reaction.author
    row.append(content, author)
    if (reaction.can_manage) {
      const remove = document.createElement("button")
      remove.type = "button"
      remove.className = "td-reaction-row__remove"
      remove.dataset.reactionRemove = String(reaction.id)
      remove.textContent = labels.remove ?? "Remove"
      remove.setAttribute("aria-label", labels.removeDescription?.replace("{reaction}", () => reaction.content) ?? `Remove reaction: ${reaction.content}`)
      row.append(remove)
    }
    return row
  }

  async function load(cursor: string | null, notice?: string): Promise<void> {
    if (busy || !isCurrent()) return
    const active = document.activeElement
    const focusMayDisappear = active === retry || active === newest || active === older || list.contains(active)
    setBusy(true)
    retryCursor = cursor
    retry.hidden = true
    error.textContent = ""
    if (panel.open) status.textContent = labels.loading ?? ""
    try {
      const response = await fetch(cursor ? `${url}?cursor=${encodeURIComponent(cursor)}` : url, { // nosemgrep
        signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
        cache: "no-store",
      })
      if (!isCurrent()) return
      if (response.status === 401 || response.status === 403) {
        const participantDenied = await isActiveParticipantProblem(response)
        if (!isCurrent()) return
        list.replaceChildren()
        groupsBar.replaceChildren()
        groupsBar.hidden = true
        myReaction = null
        syncQuickEmojiHighlights()
        form.hidden = newest.hidden = older.hidden = true
        status.textContent = (participantDenied ? labels.participantRequired : labels.unavailable) ?? ""
        return
      }
      if (!response.ok) throw new Error("Reaction list unavailable")
      const data: ReactionPage = await response.json()
      if (!isCurrent()) return
      list.replaceChildren(...data.reactions.map(render))
      list.hidden = data.reactions.length === 0

      const groups = Array.isArray(data.groups) ? data.groups : []
      const mineGroup = groups.find(g => g.reacted && g.my_reaction_id != null)
      myReaction = mineGroup && mineGroup.my_reaction_id != null
        ? { id: mineGroup.my_reaction_id, content: mineGroup.content }
        : null
      syncQuickEmojiHighlights()

      // Build author tooltips from loaded reactions so hovering a chip reveals who reacted.
      const authorsByContent = new Map<string, string[]>()
      for (const r of data.reactions) {
        const arr = authorsByContent.get(r.content) ?? []
        if (!arr.includes(r.author)) arr.push(r.author)
        authorsByContent.set(r.content, arr)
      }

      groupsBar.hidden = groups.length === 0
      groupsBar.replaceChildren(...groups.map(group => {
        const chip = document.createElement("button")
        chip.type = "button"
        chip.className = "td-reaction-chip"
        chip.dataset.reactionGroup = group.content
        chip.setAttribute("aria-pressed", String(Boolean(group.reacted)))
        chip.disabled = !data.can_react && !group.reacted
        if (group.my_reaction_id != null) chip.dataset.myReactionId = String(group.my_reaction_id)
        const authors = authorsByContent.get(group.content)
        const actionHint = group.reacted ? "Click to remove your reaction" : myReaction ? "Click to switch your reaction" : "Click to react"
        chip.title = authors?.length ? `${authors.join(", ")} — ${actionHint}` : actionHint

        const emojiSpan = document.createElement("span")
        emojiSpan.className = "td-reaction-chip__emoji"
        emojiSpan.textContent = group.content
        const countSpan = document.createElement("span")
        countSpan.className = "td-reaction-chip__count"
        countSpan.textContent = String(group.count)
        chip.append(emojiSpan, countSpan)
        return chip
      }))

      pageCursor = cursor
      nextCursor = data.next_cursor
      form.hidden = !data.can_react
      newest.hidden = cursor === null
      older.hidden = !nextCursor
      status.textContent = notice ?? (data.reactions.length ? "" : labels.empty ?? "")
    } catch {
      if (!isCurrent()) return
      status.textContent = notice ?? ""
      if (panel.open) {
        error.textContent = labels.loadFailed ?? ""
        retry.hidden = false
      }
    } finally {
      if (isCurrent()) {
        setBusy(false)
        if (panel.open && focusMayDisappear && document.activeElement === document.body) {
          const target = !retry.hidden ? retry : !older.hidden ? older : !newest.hidden ? newest : summary
          target.focus()
        }
      }
    }
  }

  async function mutate(removeId?: string, presetContent?: string): Promise<void> {
    if (busy || !isCurrent()) return
    const content = (presetContent ?? input.value).trim().normalize("NFC")
    const length = [...content].length
    error.textContent = ""
    if (!removeId && (length === 0 || length > 16)) {
      error.textContent = labels.invalid ?? ""
      input.focus()
      return
    }
    let saved = false
    setBusy(true)
    status.textContent = labels.saving ?? ""
    try {
      const safeRemoveId = removeId && /^[\w-]+$/.test(removeId) ? encodeURIComponent(removeId) : null
      if (removeId && !safeRemoveId) {
        error.textContent = labels.removeFailed ?? ""
        return
      }
      const response = await fetch(safeRemoveId ? `${url}/${safeRemoveId}` : url, { // nosemgrep
        method: safeRemoveId ? "DELETE" : "POST",
        signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
        ...(safeRemoveId ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify({ content }) }),
      })
      const participantDenied = await isActiveParticipantProblem(response)
      if (!isCurrent()) return
      saved = response.ok
      if (participantDenied) error.textContent = labels.participantRequired ?? ""
      else if (!removeId && response.status === 400) error.textContent = labels.invalid ?? ""
    } catch {
      // Keep the draft and the current page available for retry.
    } finally {
      if (isCurrent()) {
        setBusy(false)
        status.textContent = ""
      }
    }
    if (!isCurrent()) return
    if (!removeId && panel.open && form.contains(document.activeElement)) input.focus()
    if (!saved) {
      if (!error.textContent) error.textContent = (removeId ? labels.removeFailed : labels.saveFailed) ?? ""
      return
    }
    if (!removeId && presetContent === undefined) input.value = ""
    if (taskId !== undefined) document.dispatchEvent(new CustomEvent("meitheal:task-reactions-changed", { detail: taskId }))
    await load(null, removeId ? labels.removed : labels.saved)
  }

  retry.addEventListener("click", () => void load(retryCursor), { signal })
  newest.addEventListener("click", () => void load(null), { signal })
  older.addEventListener("click", () => { if (nextCursor) void load(nextCursor) }, { signal })
  groupsBar.addEventListener("click", event => {
    const pill = (event.target as Element).closest<HTMLButtonElement>("[data-reaction-group]")
    if (!pill || pill.disabled) return
    if (pill.getAttribute("aria-pressed") === "true" && pill.dataset.myReactionId) {
      void mutate(pill.dataset.myReactionId)
    } else if (pill.dataset.reactionGroup) {
      void mutate(undefined, pill.dataset.reactionGroup)
    }
  }, { signal })
  list.addEventListener("click", event => {
    const remove = (event.target as Element).closest<HTMLButtonElement>("[data-reaction-remove]")
    if (remove?.dataset.reactionRemove) void mutate(remove.dataset.reactionRemove)
  }, { signal })
  form.addEventListener("click", event => {
    const emoji = (event.target as Element).closest<HTMLButtonElement>("[data-reaction-emoji]")
    if (busy || !emoji?.dataset.reactionEmoji) return
    const chosen = emoji.dataset.reactionEmoji
    // Clicking your already-active quick emoji toggles it off; clicking another switches to it (1 user = 1 reaction).
    if (myReaction && myReaction.content === chosen) {
      void mutate(String(myReaction.id))
    } else {
      void mutate(undefined, chosen)
    }
  }, { signal })
  form.addEventListener("submit", event => {
    event.preventDefault()
    void mutate()
  }, { signal })
  if (fetchNow) void load(null)
  return {
    reload: () => { void load(pageCursor) },
  }
}
