/**
 * Agent Tokens settings panel controller.
 *
 * Bootstrapped from settings-page.ts via initAISettings() so Astro ClientRouter
 * navigations and section switches bind cleanly without component-owned scripts.
 */
import { withAsyncButton } from "@lib/async-button"
import { confirmDialog } from "@lib/confirm-dialog"
import { pageLifecycle } from "@lib/page-lifecycle"
import { showToast } from "@lib/toast"

interface TokenInfo {
  id: string
  name: string
  tokenPrefix: string
  scopes: string[]
  assigneeId?: string | null
  createdAt: string
  expiresAt: string | null
  lastUsedAt?: string | null
  revoked?: boolean
}

interface DirectoryUser {
  id: string
  name: string
  kind?: string
}

export function initAgentTokensSettings(): void {
  const listEl = document.getElementById("agent-tokens-list")
  const statusEl = document.getElementById("agent-tokens-status")
  const emptyEl = document.getElementById("agent-tokens-empty")
  const createBtn = document.getElementById("agent-token-create-btn")
  const formEl = document.getElementById("agent-token-form")
  const cancelBtn = document.getElementById("agent-token-form-cancel")
  const saveBtn = document.getElementById("agent-token-save") as HTMLButtonElement | null
  const revealEl = document.getElementById("agent-token-reveal")
  const plaintextEl = document.getElementById("agent-token-plaintext")
  const copyBtn = document.getElementById("agent-token-copy")
  const doneBtn = document.getElementById("agent-token-reveal-done")
  const nameInput = document.getElementById("agent-token-name") as HTMLInputElement | null
  const assigneeSelect = document.getElementById("agent-token-assignee") as HTMLSelectElement | null
  const newAssigneeGroup = document.getElementById("agent-token-new-assignee")
  const newAssigneeName = document.getElementById("agent-token-new-assignee-name") as HTMLInputElement | null
  const expiresSelect = document.getElementById("agent-token-expires") as HTMLSelectElement | null

  if (
    !listEl || !statusEl || !emptyEl || !createBtn || !formEl || !cancelBtn ||
    !saveBtn || !revealEl || !plaintextEl || !copyBtn || !doneBtn ||
    !nameInput || !assigneeSelect || !expiresSelect
  ) return

  const signal = pageLifecycle.signal
  const agentNames = new Map<string, string>()
  let copyTimer: ReturnType<typeof setTimeout> | undefined
  let loadSeq = 0
  let activeLoadController: AbortController | null = null

  function toggleNewAssignee() {
    if (!newAssigneeGroup || !assigneeSelect) return
    const creating = assigneeSelect.value === "__new__"
    newAssigneeGroup.hidden = !creating
    if (!creating && newAssigneeName) newAssigneeName.value = ""
  }

  function clearReveal() {
    if (copyTimer) {
      clearTimeout(copyTimer)
      copyTimer = undefined
    }
    copyBtn!.textContent = "📋 Copy"
    plaintextEl!.textContent = ""
    revealEl!.hidden = true
  }

  signal.addEventListener("abort", () => {
    activeLoadController?.abort()
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
      const createOption = assigneeSelect!.querySelector<HTMLOptionElement>('option[value="__new__"]')
      assigneeSelect!.querySelectorAll("option[data-agent-option]").forEach(opt => opt.remove())
      agentNames.clear()
      for (const user of data.users ?? []) {
        if (user?.kind !== "agent" || typeof user.id !== "string" || !user.id || typeof user.name !== "string") continue
        agentNames.set(user.id, user.name)
        const opt = new Option(user.name, user.id)
        opt.dataset.agentOption = "1"
        assigneeSelect!.insertBefore(opt, createOption ?? null)
      }
      if (current && (current === "__new__" || agentNames.has(current))) {
        assigneeSelect!.value = current
      } else {
        assigneeSelect!.value = ""
      }
      toggleNewAssignee()
    } catch {
      /* Optional directory enrichment; manual token creation remains available. */
    }
  }

  function clearTokenStatus() {
    statusEl!.hidden = true
    statusEl!.replaceChildren()
  }

  function showTokenStatus(...nodes: Array<Node | string>) {
    listEl!.querySelectorAll(".agent-tokens__row").forEach(el => el.remove())
    emptyEl!.hidden = true
    statusEl!.hidden = false
    statusEl!.replaceChildren(...nodes)
  }

  function showTokenAdminNotice() {
    clearReveal()
    formEl!.hidden = true
    if (createBtn instanceof HTMLButtonElement) createBtn.disabled = true
    showTokenStatus("Home Assistant administrator access is required to view or issue agent tokens.")
  }

  function showTokenError(focusRetry = false) {
    const retryBtn = document.createElement("button")
    retryBtn.type = "button"
    retryBtn.className = "btn btn-ghost btn-sm"
    retryBtn.id = "tokens-retry"
    retryBtn.style.marginLeft = "8px"
    retryBtn.textContent = "Retry"
    showTokenStatus("Failed to load tokens.\n", retryBtn)
    if (focusRetry) {
      retryBtn.focus()
    }
  }

  async function revokeToken(id: string) {
    const confirmed = await confirmDialog({
      message: "Revoke this token? It will immediately stop working.",
      variant: "warning",
      confirmText: "Revoke",
      signal,
    })
    if (!confirmed || signal.aborted) return
    try {
      const res = await fetch("/api/agent-tokens", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
        signal,
      })
      if (signal.aborted) return
      if (res.ok) {
        showToast("Token revoked", "success")
        await loadTokens()
        const deleteBtn = listEl!.querySelector<HTMLButtonElement>(`[data-delete="${CSS.escape(id)}"]`)
        ;(deleteBtn ?? createBtn)?.focus()
      } else {
        showToast("Failed to revoke token", "error")
      }
    } catch {
      if (!signal.aborted) showToast("Failed to revoke token", "error")
    }
  }

  async function deleteToken(id: string) {
    const deleteConfirmed = await confirmDialog({
      message: "Permanently delete this token? This cannot be undone.",
      variant: "danger",
      confirmText: "Delete",
      signal,
    })
    if (!deleteConfirmed || signal.aborted) return
    try {
      const res = await fetch("/api/agent-tokens", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, hard: true }),
        signal,
      })
      if (signal.aborted) return
      if (res.ok) {
        showToast("Token deleted", "success")
        await loadTokens()
        createBtn?.focus()
      } else {
        showToast("Failed to delete token", "error")
      }
    } catch {
      if (!signal.aborted) showToast("Failed to delete token", "error")
    }
  }

  function renderTokens(tokens: TokenInfo[], focusCreate = false) {
    clearTokenStatus()
    listEl!.querySelectorAll(".agent-tokens__row").forEach(el => el.remove())
    if (createBtn instanceof HTMLButtonElement) createBtn.disabled = false

    if (tokens.length === 0) {
      emptyEl!.hidden = false
      if (focusCreate) createBtn!.focus()
      return
    }

    emptyEl!.hidden = true

    for (const token of tokens) {
      const row = document.createElement("div")
      row.className = `agent-tokens__row${token.revoked ? " agent-tokens__revoked" : ""}`
      row.dataset.tokenId = token.id

      const info = document.createElement("div")
      info.className = "agent-tokens__row-info"

      const nameEl = document.createElement("div")
      nameEl.className = "agent-tokens__row-name"
      nameEl.textContent = token.name

      const meta = document.createElement("div")
      meta.className = "agent-tokens__row-meta"

      const prefixEl = document.createElement("span")
      prefixEl.className = "agent-tokens__row-prefix"
      prefixEl.textContent = `${token.tokenPrefix}${token.tokenPrefix.includes("...") ? "" : "…"}`
      meta.appendChild(prefixEl)

      for (const s of token.scopes) {
        const badge = document.createElement("span")
        badge.className = "agent-tokens__scope-badge"
        badge.textContent = s
        meta.appendChild(badge)
      }

      if (token.assigneeId) {
        const assigneeBadge = document.createElement("span")
        assigneeBadge.className = "agent-tokens__assignee-badge"
        const agentLabel = agentNames.get(token.assigneeId) ?? token.assigneeId
        assigneeBadge.textContent = `Acts as ${agentLabel}`
        meta.appendChild(assigneeBadge)
      }

      const createdEl = document.createElement("span")
      createdEl.textContent = `Created ${new Date(token.createdAt).toLocaleDateString()}`
      meta.appendChild(createdEl)

      const expiresEl = document.createElement("span")
      expiresEl.textContent = `· ${
        token.expiresAt
          ? `Expires ${new Date(token.expiresAt).toLocaleDateString()}`
          : "No expiry"
      }`
      meta.appendChild(expiresEl)

      info.append(nameEl, meta)

      const actions = document.createElement("div")
      actions.className = "agent-tokens__row-actions"

      if (token.revoked) {
        const revokedBadge = document.createElement("span")
        revokedBadge.className = "badge badge-pending"
        revokedBadge.textContent = "Revoked"
        actions.appendChild(revokedBadge)
      } else {
        const revokeBtn = document.createElement("button")
        revokeBtn.type = "button"
        revokeBtn.className = "btn btn-ghost btn-sm"
        revokeBtn.dataset.revoke = token.id
        revokeBtn.title = "Revoke"
        revokeBtn.setAttribute("aria-label", `Revoke token ${token.name}`)
        revokeBtn.textContent = "🚫"
        actions.appendChild(revokeBtn)
      }

      const deleteBtn = document.createElement("button")
      deleteBtn.type = "button"
      deleteBtn.className = "btn btn-ghost btn-sm"
      deleteBtn.dataset.delete = token.id
      deleteBtn.title = "Delete permanently"
      deleteBtn.setAttribute("aria-label", `Delete token ${token.name} permanently`)
      deleteBtn.textContent = "🗑"
      actions.appendChild(deleteBtn)

      row.append(info, actions)
      listEl!.appendChild(row)
    }

    if (focusCreate) createBtn!.focus()
  }

  async function loadTokens(focusRetry = false) {
    const seq = ++loadSeq
    activeLoadController?.abort()
    const controller = new AbortController()
    activeLoadController = controller
    try {
      const res = await fetch("/api/agent-tokens?include_revoked=1", {
        cache: "no-store",
        signal: controller.signal,
      })
      if (signal.aborted || seq !== loadSeq) return
      if (res.status === 403) {
        showTokenAdminNotice()
        return
      }
      if (!res.ok) {
        showTokenError(focusRetry)
        return
      }
      const tokens: TokenInfo[] = await res.json()
      if (signal.aborted || seq !== loadSeq) return
      if (tokens.some(token => token.assigneeId) && agentNames.size === 0) {
        await populateAssignees()
        if (signal.aborted || seq !== loadSeq) return
      }
      renderTokens(tokens, focusRetry)
    } catch {
      if (!signal.aborted && !controller.signal.aborted && seq === loadSeq) {
        showTokenError(focusRetry)
      }
    }
  }

  pageLifecycle.on(listEl, "click", event => {
    const target = event.target instanceof Element
      ? event.target.closest<HTMLElement>("[data-revoke], [data-delete], #tokens-retry")
      : null
    if (!target) return
    if (target.id === "tokens-retry") {
      if (target instanceof HTMLButtonElement) target.disabled = true
      void loadTokens(true)
      return
    }
    const revokeId = target.getAttribute("data-revoke")
    if (revokeId) {
      void revokeToken(revokeId)
      return
    }
    const deleteId = target.getAttribute("data-delete")
    if (deleteId) void deleteToken(deleteId)
  })

  pageLifecycle.on(assigneeSelect, "change", () => {
    toggleNewAssignee()
    if (assigneeSelect.value === "__new__") {
      const checkboxes = Array.from(document.querySelectorAll<HTMLInputElement>('[name="agent-token-scopes"]'))
      if (checkboxes.every(cb => !cb.checked)) {
        const defaults = new Set(["mcp:execute", "tasks:read", "tasks:write:assigned", "search:read"])
        checkboxes.forEach(cb => { cb.checked = defaults.has(cb.value) })
      }
      newAssigneeName?.focus()
    }
  })

  pageLifecycle.on(createBtn, "click", () => {
    clearReveal()
    formEl.hidden = false
    nameInput.value = ""
    assigneeSelect.value = ""
    toggleNewAssignee()
    expiresSelect.value = ""
    document.querySelectorAll<HTMLInputElement>('[name="agent-token-scopes"]')
      .forEach(cb => { cb.checked = false })
    nameInput.focus()
    void populateAssignees()
  })

  pageLifecycle.on(cancelBtn, "click", () => {
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

    const scopes: string[] = []
    document.querySelectorAll<HTMLInputElement>('[name="agent-token-scopes"]:checked')
      .forEach(cb => scopes.push(cb.value))

    if (scopes.length === 0) {
      showToast("Select at least one scope", "error")
      formEl.querySelector<HTMLInputElement>('[name="agent-token-scopes"]')?.focus()
      return
    }

    const creatingNewAgent = assigneeSelect.value === "__new__"
    const newAgentLabel = creatingNewAgent ? (newAssigneeName?.value.trim() ?? "") : ""
    if (creatingNewAgent && !newAgentLabel) {
      showToast("Agent name is required", "error")
      newAssigneeName?.focus()
      return
    }

    let assigneeId: string | null = creatingNewAgent ? null : (assigneeSelect.value.trim() || null)
    if (scopes.includes("tasks:write:assigned") && !scopes.includes("tasks:write") && !creatingNewAgent && !assigneeId) {
      showToast("Select an agent assignee for tasks:write:assigned", "error")
      assigneeSelect.focus()
      return
    }

    let expiresAt: string | null = null
    const exp = expiresSelect.value
    if (exp) {
      const now = Date.now()
      const ms = exp === "7d" ? 7 * 86400000 : exp === "30d" ? 30 * 86400000
        : exp === "90d" ? 90 * 86400000 : exp === "1y" ? 365 * 86400000 : 0
      if (ms) expiresAt = new Date(now + ms).toISOString()
    }

    try {
      if (creatingNewAgent) {
        const createdUserRes = await fetch("/api/users/custom", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: newAgentLabel, kind: "agent" }),
          signal,
        })
        if (signal.aborted) return
        if (!createdUserRes.ok) {
          const err = await createdUserRes.json().catch(() => ({}))
          showToast(err.error || err.detail || "Failed to create agent assignee", "error")
          newAssigneeName?.focus()
          return
        }
        const createdUser = await createdUserRes.json() as DirectoryUser
        agentNames.set(createdUser.id, createdUser.name)
        const createOption = assigneeSelect.querySelector<HTMLOptionElement>('option[value="__new__"]')
        const opt = new Option(createdUser.name, createdUser.id)
        opt.dataset.agentOption = "1"
        assigneeSelect.insertBefore(opt, createOption ?? null)
        assigneeSelect.value = createdUser.id
        assigneeId = createdUser.id
        toggleNewAssignee()
      }

      const res = await fetch("/api/agent-tokens", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, scopes, assigneeId, expiresAt }),
        signal,
      })

      if (signal.aborted) return
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        showToast(err.detail || "Failed to create token", "error")
        setTimeout(() => { if (!signal.aborted) saveBtn.focus() }, 0)
        return
      }

      const data = await res.json()
      if (signal.aborted) return

      formEl.hidden = true
      revealEl.hidden = false
      plaintextEl.textContent = data.token
      copyBtn.focus()

      showToast("Token created — copy it now!", "success")
      void loadTokens()
    } catch {
      if (!signal.aborted) {
        showToast("Failed to create token", "error")
        setTimeout(() => { if (!signal.aborted) saveBtn.focus() }, 0)
      }
    }
  }, { loadingText: "Creating…" }))

  pageLifecycle.on(copyBtn, "click", async () => {
    try {
      await navigator.clipboard.writeText(plaintextEl.textContent || "")
      if (signal.aborted) return
      showToast("Token copied to clipboard", "success")
      copyBtn.textContent = "✅ Copied"
      if (copyTimer) clearTimeout(copyTimer)
      copyTimer = setTimeout(() => {
        if (!signal.aborted) copyBtn.textContent = "📋 Copy"
      }, 2000)
    } catch {
      if (!signal.aborted) showToast("Failed to copy — select and copy manually", "error")
    }
  })

  pageLifecycle.on(doneBtn, "click", () => {
    clearReveal()
    createBtn.focus()
  })

  if (createBtn.dataset.canManageTokens === "false") {
    showTokenAdminNotice()
    return
  }

  const section = document.getElementById("automation-ai-settings")
  if (!section || !section.hidden) {
    void loadTokens()
  } else {
    const observer = new MutationObserver(() => {
      if (!section.hidden) {
        observer.disconnect()
        void loadTokens()
      }
    })
    observer.observe(section, { attributes: true, attributeFilter: ["hidden"] })
    signal.addEventListener("abort", () => observer.disconnect(), { once: true })
  }
}
