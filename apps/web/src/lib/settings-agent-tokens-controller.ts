/**
 * Agent Tokens settings panel controller — unified token + Board access management.
 *
 * Bootstrapped from settings-page.ts via initAISettings().
 */
import { withAsyncButton } from "@lib/async-button"
import { confirmDialog } from "@lib/confirm-dialog"
import { safeIngressHref } from "@lib/ingress-navigation"
import { pageLifecycle } from "@lib/page-lifecycle"
import { safeFetch } from "@lib/safe-fetch"
import { byId, domEl as el, whenSectionVisible } from "@lib/settings-utils"
import { createTablerSvgElement } from "@lib/tabler-svg"
import { showToast } from "@lib/toast"
import { qs, setAttr } from "@lib/dom-helpers"

const SAFE_PATH_SEGMENT_RE = /^[A-Za-z0-9._-]+$/

interface BoardGrant {
  id: string
  name: string
  ticketPrefix: string
}

interface TokenInfo {
  id: string
  name: string
  tokenPrefix: string
  scopes: string[]
  assigneeId?: string | null
  createdAt: string
  expiresAt: string | null
  revoked?: boolean
  boards?: BoardGrant[]
}

interface DirectoryUser {
  id: string
  name: string
  kind?: string
}

interface BoardEntry extends BoardGrant {
  role?: string
  state?: string
}

const isExpired = (iso: string | null) =>
  iso !== null && (!Number.isFinite(Date.parse(iso)) || Date.parse(iso) <= Date.now())
const metaContent = (name: string) =>
  document.querySelector<HTMLMetaElement>(`meta[name="${name}"]`)?.content.trim() || ""

export function initAgentTokensSettings(): void {
  const listEl = byId("agent-tokens-list")
  const statusEl = byId("agent-tokens-status")
  const emptyEl = byId("agent-tokens-empty")
  const createBtn = byId<HTMLButtonElement>("agent-token-create-btn")
  const formEl = byId("agent-token-form")
  const cancelBtn = byId("agent-token-form-cancel")
  const saveBtn = byId<HTMLButtonElement>("agent-token-save")
  const revealEl = byId("agent-token-reveal")
  const plaintextEl = byId("agent-token-plaintext")
  const copyBtn = byId("agent-token-copy")
  const doneBtn = byId("agent-token-reveal-done")
  const nameInput = byId<HTMLInputElement>("agent-token-name")
  const boardSelect = byId<HTMLSelectElement>("agent-token-board")
  const assigneeSelect = byId<HTMLSelectElement>("agent-token-assignee")
  const newAssigneeGroup = byId("agent-token-new-assignee")
  const newAssigneeName = byId<HTMLInputElement>("agent-token-new-assignee-name")
  const expiresSelect = byId<HTMLSelectElement>("agent-token-expires")

  if (
    !listEl || !statusEl || !emptyEl || !createBtn || !formEl || !cancelBtn ||
    !saveBtn || !revealEl || !plaintextEl || !copyBtn || !doneBtn ||
    !nameInput || !assigneeSelect || !expiresSelect
  ) return

  const signal = pageLifecycle.signal
  const agentNames = new Map<string, string>()
  let manageableBoards: BoardGrant[] = []
  let boardSession = metaContent("meitheal-work-session")
  let copyTimer: ReturnType<typeof setTimeout> | undefined
  let loadSeq = 0
  let formGen = 0
  let loadCtrl: AbortController | null = null
  let createCtrl: AbortController | null = null

  const boardHeaders = (boardId?: string): Record<string, string> => ({
    "Content-Type": "application/json",
    ...(boardId ? { "X-Meitheal-Board-Id": boardId } : {}),
    ...(boardSession ? { "X-Meitheal-Board-Session": boardSession } : {}),
  })

  const toggleNewAssignee = () => {
    if (!newAssigneeGroup) return
    const creating = assigneeSelect.value === "__new__"
    newAssigneeGroup.hidden = !creating
    if (!creating && newAssigneeName) newAssigneeName.value = ""
  }

  const setCopyState = (copied: boolean) => {
    copyBtn.replaceChildren(
      createTablerSvgElement(copied ? "check" : "clipboard-list", 14),
      document.createTextNode(copied ? " Copied" : " Copy"),
    )
  }

  const clearReveal = () => {
    if (copyTimer) {
      clearTimeout(copyTimer)
      copyTimer = undefined
    }
    setCopyState(false)
    plaintextEl.textContent = ""
    revealEl.hidden = true
  }

  signal.addEventListener("abort", () => {
    loadCtrl?.abort()
    createCtrl?.abort()
    clearReveal()
  }, { once: true })
  window.addEventListener("pagehide", clearReveal, { signal })
  window.addEventListener("pageshow", event => {
    if (event.persisted) {
      clearReveal()
      if (createBtn.dataset.canManageTokens !== "false") void loadTokens()
    }
  }, { signal })

  async function populateAssignees() {
    try {
      const res = await fetch("/api/users", { cache: "no-store", signal })
      if (!res.ok || signal.aborted) return
      const data = await res.json() as { users?: DirectoryUser[] }
      if (signal.aborted) return
      const current = assigneeSelect!.value
      const createOpt = qs<HTMLOptionElement>(assigneeSelect!, 'option[value="__new__"]')
      assigneeSelect!.querySelectorAll("option[data-agent-option]").forEach(o => o.remove())
      agentNames.clear()
      for (const u of data.users ?? []) {
        if (u?.kind !== "agent" || !u.id || !u.name) continue
        agentNames.set(u.id, u.name)
        const opt = new Option(u.name, u.id)
        opt.dataset.agentOption = "1"
        assigneeSelect!.insertBefore(opt, createOpt ?? null)
      }
      assigneeSelect!.value = current === "__new__" || agentNames.has(current) ? current : ""
      toggleNewAssignee()
    } catch { /* Optional enrichment */ }
  }

  async function loadManageableBoards() {
    try {
      const res = await fetch("/api/boards", { cache: "no-store", signal })
      if (!res.ok || signal.aborted) return
      const refreshed = res.headers.get("x-meitheal-board-session")
      if (refreshed) boardSession = refreshed
      const data = await res.json() as { boards?: BoardEntry[] }
      if (signal.aborted) return
      manageableBoards = (data.boards ?? [])
        .filter(b => b.state === "active" && b.role === "owner" && b.id)
        .map(b => ({ id: b.id, name: b.name, ticketPrefix: b.ticketPrefix || "" }))
      if (boardSelect) {
        const selected = boardSelect.value || metaContent("meitheal-work-board")
        boardSelect.replaceChildren()
        if (manageableBoards.length === 0) {
          boardSelect.add(new Option("Default Board", ""))
        } else {
          for (const b of manageableBoards) {
            const label = b.ticketPrefix ? `${b.ticketPrefix} · ${b.name}` : b.name
            boardSelect.add(new Option(label, b.id, false, b.id === selected))
          }
        }
      }
    } catch { /* Non-fatal: default board fallback remains active */ }
  }

  const showStatus = (...nodes: Array<Node | string>) => {
    listEl.querySelectorAll(".agent-tokens__row").forEach(n => n.remove())
    emptyEl.hidden = true
    statusEl.hidden = false
    statusEl.replaceChildren(...nodes)
  }

  const showAdminNotice = () => {
    clearReveal()
    formEl.hidden = true
    createBtn.disabled = true
    showStatus("Administrator access is required to view or issue agent tokens.")
  }

  const showError = (focusRetry = false) => {
    const retryBtn = el("button", "btn btn-ghost btn-sm", "Retry")
    retryBtn.type = "button"
    retryBtn.id = "tokens-retry"
    retryBtn.style.marginLeft = "8px"
    showStatus("Failed to load tokens.\n", retryBtn)
    if (focusRetry) retryBtn.focus()
  }

  async function mutateToken(id: string, hard: boolean) {
    const confirmed = await confirmDialog({
      message: hard
        ? "Permanently delete this token? This cannot be undone."
        : "Revoke this token? It will immediately stop working.",
      variant: hard ? "danger" : "warning",
      confirmText: hard ? "Delete" : "Revoke",
      signal,
    })
    if (!confirmed || signal.aborted) return
    try {
      const res = await fetch("/api/agent-tokens", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(hard ? { id, hard: true } : { id }),
        signal,
      })
      if (signal.aborted) return
      if (!res.ok) {
        showToast(hard ? "Failed to delete token" : "Failed to revoke token", "error")
        return
      }
      showToast(hard ? "Token deleted" : "Token revoked", "success")
      await loadTokens()
      const next = hard ? createBtn : qs<HTMLButtonElement>(listEl!, `[data-delete="${CSS.escape(id)}"]`)
      ;(next ?? createBtn)?.focus()
    } catch {
      if (!signal.aborted) showToast(hard ? "Failed to delete token" : "Failed to revoke token", "error")
    }
  }

  async function updateBoardAccess(boardId: string, tokenId: string, enabled: boolean) {
    if (!SAFE_PATH_SEGMENT_RE.test(boardId)) {
      showToast("Could not update Board access", "error")
      return
    }
    try {
      const res = await safeFetch(`/api/boards/${encodeURIComponent(boardId)}`, {
        method: "PATCH",
        headers: boardHeaders(boardId),
        body: JSON.stringify({ action: "agent", tokenId, enabled }),
        signal,
      })
      if (signal.aborted) return
      if (!res.ok) {
        const err = await res.json().catch(() => ({})) as { error?: string; detail?: string }
        showToast(err.error || err.detail || "Could not update Board access", "error")
        await loadTokens()
        return
      }
      showToast(enabled ? "Board access granted" : "Board access removed", "success")
      await loadTokens()
    } catch {
      if (!signal.aborted) showToast("Could not update Board access", "error")
    }
  }

  function renderTokens(tokens: TokenInfo[], focusCreate = false) {
    statusEl!.hidden = true
    statusEl!.replaceChildren()
    listEl!.querySelectorAll(".agent-tokens__row").forEach(n => n.remove())
    createBtn!.disabled = false

    if (tokens.length === 0) {
      emptyEl!.hidden = false
      if (focusCreate) createBtn!.focus()
      return
    }
    emptyEl!.hidden = true

    for (const token of tokens) {
      const expired = isExpired(token.expiresAt)
      const inactive = Boolean(token.revoked || expired)
      const row = el("div", `agent-tokens__row${inactive ? " agent-tokens__revoked" : ""}`)
      row.dataset.tokenId = token.id

      const info = el("div", "agent-tokens__row-info")
      const head = el("div", "agent-tokens__row-head")
      head.append(el("span", "agent-tokens__row-name", token.name))
      if (token.revoked) head.append(el("span", "badge badge-pending", "Revoked"))
      else if (expired) head.append(el("span", "badge badge-pending", "Expired"))

      const meta = el("div", "agent-tokens__row-meta")
      meta.append(el("span", "agent-tokens__row-prefix", `${token.tokenPrefix}${token.tokenPrefix.includes("...") ? "" : "…"}`))

      const copyIdBtn = el("button", "agent-tokens__copy-id")
      copyIdBtn.type = "button"
      copyIdBtn.dataset.copyId = token.id
      copyIdBtn.title = `Copy token ID (${token.id})`
      copyIdBtn.append(createTablerSvgElement("copy", 11), document.createTextNode(" Copy ID"))
      meta.append(copyIdBtn)

      for (const s of token.scopes) meta.append(el("span", "agent-tokens__scope-badge", s))
      if (token.assigneeId) {
        meta.append(el("span", "agent-tokens__assignee-badge", `Acts as ${agentNames.get(token.assigneeId) ?? token.assigneeId}`))
      }
      meta.append(
        el("span", undefined, `Created ${new Date(token.createdAt).toLocaleDateString()}`),
        el("span", undefined, `· ${token.expiresAt ? `Expires ${new Date(token.expiresAt).toLocaleDateString()}` : "No expiry"}`),
      )

      const boardsBar = el("div", "agent-tokens__boards")
      boardsBar.append(el("span", "agent-tokens__boards-label", "Boards:"))
      const granted = token.boards ?? []
      const grantedIds = new Set(granted.map(b => b.id))
      const manageableIds = new Set(manageableBoards.map(b => b.id))

      if (granted.length === 0) {
        boardsBar.append(el("span", undefined, "None"))
      } else {
        for (const b of granted) {
          const chip = el("span", "agent-tokens__board-chip")
          const link = el("a", "agent-tokens__board-link", b.ticketPrefix ? `${b.ticketPrefix} · ${b.name}` : b.name)
          link.href = safeIngressHref(`/boards/${encodeURIComponent(b.id)}?view=groups#settings`)
          link.title = `Open ${b.name} Board Settings`
          chip.append(link)
          if (manageableIds.has(b.id)) {
            const rm = el("button", "agent-tokens__board-remove")
            rm.type = "button"
            rm.dataset.boardRemove = b.id
            rm.dataset.boardToken = token.id
            rm.title = `Remove ${b.name} access`
            setAttr(rm, "aria-label", `Remove ${b.name} access for ${token.name}`)
            rm.append(createTablerSvgElement("x", 11))
            chip.append(rm)
          }
          boardsBar.append(chip)
        }
      }

      const addable = inactive ? [] : manageableBoards.filter(b => !grantedIds.has(b.id))
      if (addable.length > 0) {
        const addSel = el("select", "agent-tokens__board-add")
        addSel.dataset.boardAddToken = token.id
        setAttr(addSel, "aria-label", `Grant Board access for ${token.name}`)
        addSel.add(new Option("+ Grant Board…", ""))
        for (const b of addable) addSel.add(new Option(b.ticketPrefix ? `${b.ticketPrefix} · ${b.name}` : b.name, b.id))
        boardsBar.append(addSel)
      }

      info.append(head, meta, boardsBar)

      const actions = el("div", "agent-tokens__row-actions")
      if (!token.revoked) {
        const revokeBtn = el("button", "btn btn-ghost btn-sm")
        revokeBtn.type = "button"
        revokeBtn.dataset.revoke = token.id
        revokeBtn.title = "Revoke"
        setAttr(revokeBtn, "aria-label", `Revoke token ${token.name}`)
        revokeBtn.append(createTablerSvgElement("x", 14))
        actions.append(revokeBtn)
      }
      const deleteBtn = el("button", "btn btn-ghost btn-sm")
      deleteBtn.type = "button"
      deleteBtn.dataset.delete = token.id
      deleteBtn.title = "Delete permanently"
      setAttr(deleteBtn, "aria-label", `Delete token ${token.name} permanently`)
      deleteBtn.append(createTablerSvgElement("trash", 14))
      actions.append(deleteBtn)

      row.append(info, actions)
      listEl!.append(row)
    }
    if (focusCreate) createBtn!.focus()
  }

  async function loadTokens(focusRetry = false) {
    const seq = ++loadSeq
    loadCtrl?.abort()
    const ctrl = new AbortController()
    loadCtrl = ctrl
    try {
      const [res] = await Promise.all([
        fetch("/api/agent-tokens?include_revoked=1", { cache: "no-store", signal: ctrl.signal }),
        loadManageableBoards(),
      ])
      if (signal.aborted || seq !== loadSeq) return
      if (res.status === 403) {
        showAdminNotice()
        return
      }
      if (!res.ok) {
        showError(focusRetry)
        return
      }
      const tokens: TokenInfo[] = await res.json()
      if (signal.aborted || seq !== loadSeq) return
      if (tokens.some(t => t.assigneeId) && agentNames.size === 0) {
        await populateAssignees()
        if (signal.aborted || seq !== loadSeq) return
      }
      renderTokens(tokens, focusRetry)
    } catch {
      if (!signal.aborted && !ctrl.signal.aborted && seq === loadSeq) showError(focusRetry)
    }
  }

  pageLifecycle.on(listEl, "click", event => {
    const target = event.target instanceof Element
      ? event.target.closest<HTMLElement>("[data-revoke], [data-delete], [data-copy-id], [data-board-remove], #tokens-retry")
      : null
    if (!target) return
    if (target.id === "tokens-retry") {
      if (target instanceof HTMLButtonElement) target.disabled = true
      void loadTokens(true)
      return
    }
    if (target.dataset.copyId) {
      void navigator.clipboard.writeText(target.dataset.copyId)
        .then(() => showToast("Token ID copied", "success"))
        .catch(() => showToast("Could not copy token ID", "error"))
      return
    }
    if (target.dataset.boardRemove && target.dataset.boardToken) {
      if (target instanceof HTMLButtonElement) target.disabled = true
      void updateBoardAccess(target.dataset.boardRemove, target.dataset.boardToken, false)
      return
    }
    if (target.dataset.revoke) void mutateToken(target.dataset.revoke, false)
    else if (target.dataset.delete) void mutateToken(target.dataset.delete, true)
  })

  pageLifecycle.on(listEl, "change", event => {
    const select = event.target
    if (!(select instanceof HTMLSelectElement) || !select.dataset.boardAddToken || !select.value) return
    const boardId = select.value
    const tokenId = select.dataset.boardAddToken
    select.disabled = true
    void updateBoardAccess(boardId, tokenId, true)
  })

  pageLifecycle.on(assigneeSelect, "change", () => {
    toggleNewAssignee()
    if (assigneeSelect.value === "__new__") {
      const boxes = Array.from(document.querySelectorAll<HTMLInputElement>('[name="agent-token-scopes"]'))
      if (boxes.every(cb => !cb.checked)) {
        const defaults = new Set(["mcp:execute", "tasks:read", "tasks:write:assigned", "search:read"])
        boxes.forEach(cb => { cb.checked = defaults.has(cb.value) })
      }
      newAssigneeName?.focus()
    }
  })

  pageLifecycle.on(createBtn, "click", () => {
    formGen++
    createCtrl?.abort()
    createCtrl = null
    clearReveal()
    formEl.hidden = false
    nameInput.value = ""
    assigneeSelect.value = ""
    toggleNewAssignee()
    expiresSelect.value = ""
    document.querySelectorAll<HTMLInputElement>('[name="agent-token-scopes"]').forEach(cb => { cb.checked = false })
    nameInput.focus()
    void Promise.all([populateAssignees(), loadManageableBoards()])
  })

  pageLifecycle.on(cancelBtn, "click", () => {
    formGen++
    createCtrl?.abort()
    createCtrl = null
    assigneeSelect.value = ""
    toggleNewAssignee()
    formEl.hidden = true
    createBtn.focus()
  })

  pageLifecycle.on(saveBtn, "click", withAsyncButton(saveBtn, async () => {
    const name = nameInput.value.trim()
    if (!name) {
      showToast("Token name is required", "error")
      nameInput.focus()
      return
    }
    const scopes = Array.from(document.querySelectorAll<HTMLInputElement>('[name="agent-token-scopes"]:checked')).map(cb => cb.value)
    if (scopes.length === 0) {
      showToast("Select at least one scope", "error")
      qs<HTMLInputElement>(formEl, '[name="agent-token-scopes"]')?.focus()
      return
    }
    const creatingNew = assigneeSelect.value === "__new__"
    const newLabel = creatingNew ? (newAssigneeName?.value.trim() ?? "") : ""
    if (creatingNew && !newLabel) {
      showToast("Agent name is required", "error")
      newAssigneeName?.focus()
      return
    }
    let assigneeId: string | null = creatingNew ? null : (assigneeSelect.value.trim() || null)
    if (scopes.includes("tasks:write:assigned") && !scopes.includes("tasks:write") && !creatingNew && !assigneeId) {
      showToast("Select an agent assignee for tasks:write:assigned", "error")
      assigneeSelect.focus()
      return
    }
    const days = ({ "7d": 7, "30d": 30, "90d": 90, "1y": 365 } as Record<string, number>)[expiresSelect.value]
    const expiresAt = days ? new Date(Date.now() + days * 86400000).toISOString() : null

    const gen = formGen
    createCtrl?.abort()
    const ctrl = new AbortController()
    createCtrl = ctrl
    const reqSignal = AbortSignal.any([signal, ctrl.signal])
    const stale = () => signal.aborted || ctrl.signal.aborted || gen !== formGen

    try {
      if (creatingNew) {
        const uRes = await fetch("/api/users/custom", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: newLabel, kind: "agent" }),
          signal: reqSignal,
        })
        if (stale()) return
        if (!uRes.ok) {
          const err = await uRes.json().catch(() => ({})) as { error?: string; detail?: string }
          showToast(err.error || err.detail || "Failed to create agent assignee", "error")
          newAssigneeName?.focus()
          return
        }
        const created = await uRes.json() as DirectoryUser
        agentNames.set(created.id, created.name)
        const opt = new Option(created.name, created.id)
        opt.dataset.agentOption = "1"
        assigneeSelect.insertBefore(opt, qs(assigneeSelect, 'option[value="__new__"]'))
        assigneeSelect.value = created.id
        toggleNewAssignee()
        assigneeId = created.id
      }

      const selectedBoard = boardSelect?.value.trim() || undefined
      const res = await fetch("/api/agent-tokens", {
        method: "POST",
        headers: boardHeaders(selectedBoard),
        body: JSON.stringify({ name, scopes, assigneeId, expiresAt }),
        signal: reqSignal,
      })
      if (stale()) return
      if (!res.ok) {
        const err = await res.json().catch(() => ({})) as { error?: string; detail?: string }
        showToast(err.detail || err.error || "Failed to create token", "error")
        setTimeout(() => { if (!stale()) saveBtn.focus() }, 0)
        return
      }
      const data = await res.json() as { token: string }
      if (stale()) return
      formEl.hidden = true
      revealEl.hidden = false
      plaintextEl.textContent = data.token
      copyBtn.focus()
      showToast("Token created — copy it now!", "success")
      void loadTokens()
    } catch {
      if (!stale()) {
        showToast("Failed to create token", "error")
        setTimeout(() => { if (!stale()) saveBtn.focus() }, 0)
      }
    } finally {
      if (createCtrl === ctrl) createCtrl = null
    }
  }, { loadingText: "Creating…" }))

  pageLifecycle.on(copyBtn, "click", async () => {
    try {
      await navigator.clipboard.writeText(plaintextEl.textContent || "")
      if (signal.aborted) return
      showToast("Token copied to clipboard", "success")
      setCopyState(true)
      if (copyTimer) clearTimeout(copyTimer)
      copyTimer = setTimeout(() => { if (!signal.aborted) setCopyState(false) }, 2000)
    } catch {
      if (!signal.aborted) showToast("Failed to copy — select and copy manually", "error")
    }
  })

  pageLifecycle.on(doneBtn, "click", () => {
    clearReveal()
    createBtn.focus()
  })

  if (createBtn.dataset.canManageTokens === "false") {
    showAdminNotice()
    return
  }

  whenSectionVisible(byId("automation-ai-settings") ?? byId("ai-agents-settings"), () => {
    void loadTokens()
  })
}
