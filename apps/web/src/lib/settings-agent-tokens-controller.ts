/**
 * Agent Tokens settings panel controller.
 *
 * Bootstrapped from settings-page.ts via initAISettings() so Astro ClientRouter
 * navigations and section switches bind cleanly without component-owned scripts.
 */
import { withAsyncButton } from "@lib/async-button"
import { confirmDialog } from "@lib/confirm-dialog"
import { pageLifecycle } from "@lib/page-lifecycle"
import { escapeHtml } from "@lib/safe-html"
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
  const expiresSelect = document.getElementById("agent-token-expires") as HTMLSelectElement | null

  if (
    !listEl || !statusEl || !emptyEl || !createBtn || !formEl || !cancelBtn ||
    !saveBtn || !revealEl || !plaintextEl || !copyBtn || !doneBtn ||
    !nameInput || !assigneeSelect || !expiresSelect
  ) return

  const signal = pageLifecycle.signal
  let copyTimer: ReturnType<typeof setTimeout> | undefined
  let loadSeq = 0
  let activeLoadController: AbortController | null = null

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
      assigneeSelect!.replaceChildren(new Option("None (unassigned)", ""))
      for (const user of data.users ?? []) {
        if (typeof user?.id === "string" && user.id && typeof user?.name === "string") {
          assigneeSelect!.add(new Option(`${user.name} (${user.id})`, user.id))
        }
      }
      assigneeSelect!.value = current
    } catch {
      /* Optional directory enrichment; manual token creation remains available. */
    }
  }

  function clearTokenStatus() {
    statusEl!.hidden = true
    statusEl!.replaceChildren()
  }

  function showTokenStatus(html: string) {
    listEl!.querySelectorAll(".agent-tokens__row").forEach(el => el.remove())
    emptyEl!.hidden = true
    statusEl!.hidden = false
    statusEl!.innerHTML = html
  }

  function showTokenAdminNotice() {
    clearReveal()
    formEl!.hidden = true
    if (createBtn instanceof HTMLButtonElement) createBtn.disabled = true
    showTokenStatus("Home Assistant administrator access is required to view or issue agent tokens.")
  }

  function showTokenError(focusRetry = false) {
    showTokenStatus(
      `Failed to load tokens.\n<button type="button" class="btn btn-ghost btn-sm" id="tokens-retry" style="margin-left: 8px;">Retry</button>`,
    )
    if (focusRetry) {
      document.getElementById("tokens-retry")?.focus()
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

      const scopeBadges = token.scopes
        .map(s => `<span class="agent-tokens__scope-badge">${escapeHtml(s)}</span>`)
        .join("")
      const assigneeBadge = token.assigneeId
        ? `<span class="agent-tokens__scope-badge">assignee:${escapeHtml(token.assigneeId)}</span>`
        : ""

      const created = new Date(token.createdAt).toLocaleDateString()
      const expires = token.expiresAt
        ? `Expires ${new Date(token.expiresAt).toLocaleDateString()}`
        : "No expiry"

      row.innerHTML = `
        <div class="agent-tokens__row-info">
          <div class="agent-tokens__row-name">${escapeHtml(token.name)}</div>
          <div class="agent-tokens__row-meta">
            <span class="agent-tokens__row-prefix">${escapeHtml(token.tokenPrefix)}${token.tokenPrefix.includes("...") ? "" : "…"}</span>
            ${scopeBadges}
            ${assigneeBadge}
            <span>Created ${created}</span>
            <span>· ${expires}</span>
          </div>
        </div>
        <div class="agent-tokens__row-actions">
          ${token.revoked
            ? '<span class="badge badge-pending">Revoked</span>'
            : `<button type="button" class="btn btn-ghost btn-sm" data-revoke="${escapeHtml(token.id)}" title="Revoke" aria-label="Revoke token ${escapeHtml(token.name)}">🚫</button>`
          }
          <button type="button" class="btn btn-ghost btn-sm" data-delete="${escapeHtml(token.id)}" title="Delete permanently" aria-label="Delete token ${escapeHtml(token.name)} permanently">🗑</button>
        </div>
      `
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

  pageLifecycle.on(createBtn, "click", () => {
    clearReveal()
    formEl.hidden = false
    nameInput.value = ""
    assigneeSelect.value = ""
    expiresSelect.value = ""
    document.querySelectorAll<HTMLInputElement>('[name="agent-token-scopes"]')
      .forEach(cb => { cb.checked = false })
    nameInput.focus()
    void populateAssignees()
  })

  pageLifecycle.on(cancelBtn, "click", () => {
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

    const assigneeId = assigneeSelect.value.trim() || null
    if (scopes.includes("tasks:write:assigned") && !scopes.includes("tasks:write") && !assigneeId) {
      showToast("Select an assignee for tasks:write:assigned", "error")
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
