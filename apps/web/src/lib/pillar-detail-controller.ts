/**
 * pillar-detail-controller.ts — Client controller for PillarDetailModal
 *
 * Opens / closes the Pillar detail popup, renders Principle CRUD inline,
 * delegates edit to PillarFormModal, and handles Pillar deletion.
 *
 * Listens for `open-pillar-detail` CustomEvent dispatched by PillarCard.
 *
 * @domain pillars
 * @phase 20 — Pillars UX Optimization
 */
import { pageLifecycle } from "@lib/page-lifecycle"
import { escapeHtml } from "@lib/safe-html"

interface PillarDetail {
  id: string
  slug: string
  name: string
  manifesto: string | null
  icon: string
  colorHex: string
  weight: number
  principles: Array<{
    id: string
    pillarId: string
    statement: string
    isNonNegotiable: boolean
    position: number
    createdAt: number
  }>
  linkedGoalCount: number
}

let currentPillar: PillarDetail | null = null

function getEl<T extends HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null
}

/* ── Shield SVG ─────────────────────────────────────────────────── */
const shieldSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="1"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>`

/* ── Render ──────────────────────────────────────────────────────── */

function renderWeight(weight: number, color: string): string {
  let html = ""
  for (let i = 1; i <= 10; i++) {
    const cls = i <= weight ? "pillar-detail-modal__weight-dot pillar-detail-modal__weight-dot--filled" : "pillar-detail-modal__weight-dot"
    html += `<span class="${cls}"></span>`
  }
  html += `<span class="pillar-detail-modal__weight-label">${weight}/10</span>`
  return html
}

function renderPrinciple(p: PillarDetail["principles"][0]): string {
  const nnClass = p.isNonNegotiable ? " pillar-detail-modal__principle-item--nn" : ""
  const nnBadge = p.isNonNegotiable
    ? `<span class="pillar-detail-modal__principle-nn-badge" title="Non-Negotiable">${shieldSvg}</span>`
    : ""
  const nnToggleClass = p.isNonNegotiable
    ? "pillar-detail-modal__principle-nn-toggle pillar-detail-modal__principle-nn-toggle--active"
    : "pillar-detail-modal__principle-nn-toggle"

  return `
    <li class="pillar-detail-modal__principle-item${nnClass}" data-principle-id="${p.id}">
      ${nnBadge}
      <span class="pillar-detail-modal__principle-text">${escapeHtml(p.statement)}</span>
      <div class="pillar-detail-modal__principle-actions">
        <button type="button" class="${nnToggleClass}" data-action="toggle-nn" title="${p.isNonNegotiable ? "Remove Non-Negotiable" : "Mark Non-Negotiable"}">
          ${shieldSvg}
        </button>
        <button type="button" class="pillar-detail-modal__principle-action-btn pillar-detail-modal__principle-action-btn--danger" data-action="delete-principle" title="Delete Principle">
          <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>
    </li>
  `
}

function renderPrinciples(principles: PillarDetail["principles"]): string {
  if (principles.length === 0) {
    return `<li class="pillar-detail-modal__principles-empty">No principles yet. Click + to add your first behavioral boundary.</li>`
  }
  const sorted = [...principles].sort((a, b) => {
    if (a.isNonNegotiable !== b.isNonNegotiable) return a.isNonNegotiable ? -1 : 1
    return a.position - b.position
  })
  return sorted.map((p) => renderPrinciple(p)).join("")
}


/* ── Open / Close ────────────────────────────────────────────────── */

function openModal(pillar: PillarDetail, opts?: { showPrincipleForm?: boolean }) {
  currentPillar = pillar
  const overlay = getEl("pillar-detail-overlay")
  if (!overlay) return

  // Set CSS custom property for pillar accent
  overlay.style.setProperty("--pillar-accent", pillar.colorHex || "var(--accent)")

  // Header
  const icon = getEl("pillar-detail-icon")
  if (icon) icon.textContent = pillar.icon || "🏛️"

  const title = getEl("pillar-detail-title")
  if (title) title.textContent = pillar.name

  // Weight
  const weight = getEl("pillar-detail-weight")
  if (weight) weight.innerHTML = renderWeight(pillar.weight, pillar.colorHex)

  // Accent bar
  const accent = getEl("pillar-detail-accent")
  if (accent) accent.style.background = pillar.colorHex || "var(--accent)"

  // Manifesto
  const manifestoText = getEl("pillar-detail-manifesto-text")
  const manifestoWrap = getEl("pillar-detail-manifesto")
  if (manifestoText && manifestoWrap) {
    if (pillar.manifesto) {
      manifestoText.textContent = pillar.manifesto
      manifestoText.className = "pillar-detail-modal__manifesto-text"
    } else {
      manifestoText.textContent = "No manifesto yet. Click edit to add one."
      manifestoText.className = "pillar-detail-modal__manifesto-empty"
    }
  }

  // Principles
  const principlesList = getEl("pillar-detail-principles")
  if (principlesList) principlesList.innerHTML = renderPrinciples(pillar.principles)

  // Show or hide add-principle form based on caller request
  const principleForm = getEl("pillar-detail-principle-form")
  if (principleForm) {
    principleForm.hidden = !opts?.showPrincipleForm
    if (opts?.showPrincipleForm) {
      // Auto-focus the input after the modal opens
      requestAnimationFrame(() => {
        const input = principleForm.querySelector<HTMLInputElement>("input")
        if (input) input.focus()
      })
    }
  }

  // Show overlay
  overlay.classList.add("active")
  document.body.style.overflow = "hidden"

  // Focus close button
  getEl("pillar-detail-close")?.focus()
}

function closeModal() {
  const overlay = getEl("pillar-detail-overlay")
  if (!overlay) return
  overlay.classList.remove("active")
  document.body.style.overflow = ""
  currentPillar = null
}

/* ── Principle CRUD ──────────────────────────────────────────────── */

async function addPrinciple() {
  if (!currentPillar) return
  const input = getEl<HTMLInputElement>("pillar-detail-principle-input")
  const nnCheck = getEl<HTMLInputElement>("pillar-detail-nn-check")
  if (!input || !input.value.trim()) return

  try {
    const resp = await fetch(`/api/pillars/${currentPillar.id}/principles`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "create",
        statement: input.value.trim(),
        isNonNegotiable: nnCheck?.checked ?? false,
      }),
    })
    if (!resp.ok) throw new Error("Failed to add principle")

    const data = await resp.json()
    currentPillar.principles.push(data.principle || data)

    // Re-render
    const principlesList = getEl("pillar-detail-principles")
    if (principlesList) principlesList.innerHTML = renderPrinciples(currentPillar.principles)

    // Reset form
    input.value = ""
    if (nnCheck) nnCheck.checked = false
    getEl("pillar-detail-principle-form")!.hidden = true

    // Dispatch refresh event so PillarCards update
    document.dispatchEvent(new CustomEvent("pillar-data-changed"))
  } catch {
    // Silently handle — toast could be added here
  }
}

async function deletePrinciple(principleId: string) {
  if (!currentPillar) return
  try {
    const resp = await fetch(`/api/pillars/${currentPillar.id}/principles`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "delete", principleId }),
    })
    if (!resp.ok) throw new Error("Failed to delete principle")

    currentPillar.principles = currentPillar.principles.filter((p) => p.id !== principleId)

    const principlesList = getEl("pillar-detail-principles")
    if (principlesList) principlesList.innerHTML = renderPrinciples(currentPillar.principles)

    document.dispatchEvent(new CustomEvent("pillar-data-changed"))
  } catch {
    // Silently handle
  }
}

async function toggleNonNegotiable(principleId: string) {
  if (!currentPillar) return
  const principle = currentPillar.principles.find((p) => p.id === principleId)
  if (!principle) return

  try {
    const resp = await fetch(`/api/pillars/${currentPillar.id}/principles`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "update",
        principleId,
        isNonNegotiable: !principle.isNonNegotiable,
      }),
    })
    if (!resp.ok) throw new Error("Failed to toggle non-negotiable")

    principle.isNonNegotiable = !principle.isNonNegotiable

    const principlesList = getEl("pillar-detail-principles")
    if (principlesList) principlesList.innerHTML = renderPrinciples(currentPillar.principles)

    document.dispatchEvent(new CustomEvent("pillar-data-changed"))
  } catch {
    // Silently handle
  }
}

/* ── Pillar Delete ───────────────────────────────────────────────── */

async function deletePillar() {
  if (!currentPillar) return
  if (!confirm(`Delete "${currentPillar.name}"? This cannot be undone.`)) return

  try {
    const resp = await fetch(`/api/pillars/${currentPillar.id}`, { method: "DELETE" })
    if (!resp.ok) throw new Error("Failed to delete pillar")

    closeModal()
    document.dispatchEvent(new CustomEvent("pillar-data-changed"))

    // Reload page to reflect deletion
    window.location.reload()
  } catch {
    // Silently handle
  }
}

/* ── Boot ─────────────────────────────────────────────────────────── */

function boot(signal: AbortSignal) {
  // Close handlers
  getEl("pillar-detail-close")?.addEventListener("click", closeModal, { signal })

  const overlay = getEl("pillar-detail-overlay")
  overlay?.addEventListener("click", (e) => {
    if (e.target === overlay) closeModal()
  }, { signal })

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && overlay?.classList.contains("active")) {
      closeModal()
    }
  }, { signal })

  // Edit button → open PillarFormModal
  getEl("pillar-detail-edit-btn")?.addEventListener("click", () => {
    if (!currentPillar) return
    closeModal()
    // Populate PillarFormModal with current data, then open it
    const modal = document.getElementById("pillar-form-modal") as HTMLElement | null
    if (!modal) return

    // Pre-fill form fields
    const nameInput = modal.querySelector<HTMLInputElement>("#pillar-name")
    const manifestoInput = modal.querySelector<HTMLTextAreaElement>("#pillar-manifesto")
    const iconInput = modal.querySelector<HTMLInputElement>("#pillar-icon")
    const colorInput = modal.querySelector<HTMLInputElement>("#pillar-color")
    const weightInput = modal.querySelector<HTMLInputElement>("#pillar-weight")

    if (nameInput) nameInput.value = currentPillar.name
    if (manifestoInput) manifestoInput.value = currentPillar.manifesto || ""
    if (iconInput) iconInput.value = currentPillar.icon || ""
    if (colorInput) colorInput.value = currentPillar.colorHex || "#6366F1"
    if (weightInput) weightInput.value = String(currentPillar.weight)

    // Set modal to edit mode
    modal.dataset.pillarId = currentPillar.id
    modal.dataset.mode = "edit"

    // Update modal title
    const title = modal.querySelector("#pillar-modal-title")
    if (title) title.textContent = modal.dataset.editLabel || "Edit Pillar"

    // Update button text
    const saveBtn = modal.querySelector("#pillar-save-btn")
    if (saveBtn) saveBtn.textContent = modal.dataset.saveLabel || "Save Changes"

    // Open the form modal
    modal.classList.add("active")
    document.body.style.overflow = "hidden"
  }, { signal })

  // Delete button
  getEl("pillar-detail-delete-btn")?.addEventListener("click", deletePillar, { signal })

  // Add principle toggle
  getEl("pillar-detail-add-principle")?.addEventListener("click", () => {
    const form = getEl("pillar-detail-principle-form")
    if (form) {
      form.hidden = !form.hidden
      if (!form.hidden) {
        getEl<HTMLInputElement>("pillar-detail-principle-input")?.focus()
      }
    }
  }, { signal })

  // Principle save
  getEl("pillar-detail-principle-save")?.addEventListener("click", addPrinciple, { signal })

  // Principle cancel
  getEl("pillar-detail-principle-cancel")?.addEventListener("click", () => {
    const form = getEl("pillar-detail-principle-form")
    if (form) form.hidden = true
    const input = getEl<HTMLInputElement>("pillar-detail-principle-input")
    if (input) input.value = ""
  }, { signal })

  // Enter to submit principle
  getEl("pillar-detail-principle-input")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") addPrinciple()
  }, { signal })

  // Delegated click handlers on principles list
  getEl("pillar-detail-principles")?.addEventListener("click", (e) => {
    const target = e.target as HTMLElement
    const btn = target.closest("[data-action]") as HTMLElement | null
    if (!btn) return
    const item = btn.closest("[data-principle-id]") as HTMLElement | null
    if (!item) return
    const id = item.dataset.principleId!

    const action = btn.dataset.action
    if (action === "delete-principle") {
      deletePrinciple(id)
    } else if (action === "toggle-nn") {
      toggleNonNegotiable(id)
    }
  }, { signal })

  // Listen for CustomEvent to open modal
  document.addEventListener("open-pillar-detail", ((e: CustomEvent<PillarDetail & { showPrincipleForm?: boolean }>) => {
    const { showPrincipleForm = false, ...pillar } = e.detail
    openModal(pillar as PillarDetail, { showPrincipleForm })
  }) as EventListener, { signal })

  // After PillarFormModal saves, refresh detail if it was editing current pillar
  document.addEventListener("pillar-data-changed", async () => {
    if (!currentPillar || !overlay?.classList.contains("active")) return
    // Refetch the pillar data
    try {
      const resp = await fetch(`/api/pillars/${currentPillar.id}`)
      if (!resp.ok) return
      const data = await resp.json()
      if (data.pillar) {
        // Merge — keep principles from current state if API doesn't include them
        const refreshed: PillarDetail = {
          ...data.pillar,
          slug: data.pillar.slug || data.pillar.id,
          principles: data.pillar.principles || currentPillar.principles,
          linkedGoalCount: data.pillar.linkedGoalCount ?? currentPillar.linkedGoalCount,
        }
        openModal(refreshed)
      }
    } catch {
      // Silently handle
    }
  }, { signal })
}

pageLifecycle.onPageLoad(boot)
