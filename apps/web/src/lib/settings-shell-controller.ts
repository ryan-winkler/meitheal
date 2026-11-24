import { saveNavigationState } from "@lib/ingress-state-persistence"
import { pageLifecycle } from "@lib/page-lifecycle"
import {
  buildCompanionNavigateUrl,
  buildCompanionXCallbackUrl,
  buildIngressPagePath,
} from "@lib/page-shell-links"
import { resolveSettingsSectionId, type SettingsSectionId } from "@lib/settings-section-ids"
import { showToast } from "@lib/toast"
import { initUnifiedBarSearchLauncher } from "@lib/unified-bar-controller"
import { byId, qs, setAttr } from "@lib/dom-helpers"

function buildCompanionNavigateHref(sectionId: SettingsSectionId): string {
  return buildCompanionNavigateUrl(buildIngressPagePath("/settings", sectionId))
}

function buildCompanionXCallbackHref(sectionId: SettingsSectionId): string {
  return buildCompanionXCallbackUrl(buildIngressPagePath("/settings", sectionId))
}

function initCompanionLinks(): void {
  document
    .querySelectorAll<HTMLAnchorElement>("[data-companion-link]")
    .forEach((link) => {
      const sectionId = (link.dataset.companionLink ||
        "app-pwa-settings") as SettingsSectionId
      link.href = buildCompanionNavigateHref(sectionId)
    })

  document
    .querySelectorAll<HTMLElement>("[data-companion-xcallback]")
    .forEach((container) => {
      const sectionId = (container.dataset.companionXcallback ||
        "app-pwa-settings") as SettingsSectionId
      const xCallbackHref = buildCompanionXCallbackHref(sectionId)
      const preview = qs<HTMLElement>(container, "[data-companion-xcallback-preview]")
      const copyButton = qs<HTMLButtonElement>(container, "[data-companion-xcallback-button]")

      if (preview) preview.textContent = xCallbackHref

      if (!copyButton) return
      pageLifecycle.on(copyButton, "click", async () => {
        try {
          await navigator.clipboard.writeText(xCallbackHref)
          showToast("settings.pwa_companion_copied", "success")
        } catch {
          showToast("settings.pwa_companion_copy_failed", "error")
        }
      })
    })
}

function initGoToTop(): void {
  const button = byId("settings-go-top")
  const marker = byId("settings-scroll-marker")
  if (!button || !marker) return

  const observer = new IntersectionObserver(([entry]) => {
    if (entry) button.hidden = entry.boundingClientRect.bottom >= 0
  })
  observer.observe(marker)
  pageLifecycle.signal.addEventListener("abort", () => observer.disconnect(), { once: true })

  pageLifecycle.on(button, "click", () => {
    document.querySelector<HTMLElement>("#settings-bar h1")?.focus({ preventScroll: true })
    window.scrollTo({ top: 0, behavior: "instant" })
  })
}

export function initSettingsShell(): void {
  const shell = byId("settings-shell")
  const directory = byId("settings-directory")
  const toggle = byId("settings-sections-toggle")
  const panels = byId("settings-panels")
  if (!shell || !directory || !toggle || !panels) return

  const narrow = window.matchMedia("(max-width: 860px)")
  const sections = panels.querySelectorAll<HTMLElement>("[data-settings-shell-section]")
  const links = directory.querySelectorAll<HTMLAnchorElement>("[data-settings-nav]")

  function setDirectoryOpen(open: boolean): void {
    setAttr(toggle!, "aria-expanded", String(open))
    directory!.hidden = !open
    shell!.toggleAttribute("data-directory-collapsed", !open)
  }

  function showDestination(hash: string, moveFocus: boolean): void {
    let id = ""
    try {
      id = decodeURIComponent(hash.slice(1))
    } catch {
      // A malformed fragment still opens Look & Feel.
    }
    // The shared skip link keeps the active section and its native behavior.
    if (id === "main-content") return

    const aliasedId = id ? resolveSettingsSectionId(id) : undefined
    const rawTarget = id ? byId(id) : null
    const section =
      (aliasedId ? byId(aliasedId) : null) ??
      rawTarget?.closest<HTMLElement>("[data-settings-shell-section]") ??
      null
    const sectionId = section?.id ?? "look-and-feel-settings"
    const isLegacyWrapper = Boolean(
      aliasedId &&
        rawTarget &&
        !rawTarget.matches("[data-settings-shell-section]") &&
        !(rawTarget instanceof HTMLDetailsElement),
    )
    const target = isLegacyWrapper ? section : (rawTarget ?? section)
    sections.forEach((element) => { element.hidden = element.id !== sectionId })
    links.forEach((link) => {
      if (link.dataset.settingsNav === sectionId) setAttr(link, "aria-current", "location")
      else link.removeAttribute("aria-current")
    })
    if (narrow.matches) setDirectoryOpen(false)
    if (!moveFocus || !target || (!section && !target.closest("#settings-bar"))) return

    // Reveal parent disclosures in outer-to-inner order before moving focus.
    const integration = target.closest(".integration-card")
    const body = qs<HTMLElement>(integration, ".integration-card__body")
    if (body) window.expandIntegrationCard?.(body.id)
    for (let node: HTMLElement | null = target; node && node !== section; node = node.parentElement) {
      if (node instanceof HTMLDetailsElement) node.open = true
      if (node.hasAttribute("data-settings-card") && node.dataset.cardCollapsed === "true") {
        setSettingsCardOpen(node, true)
      }
    }
    const destination = target === section
      ? qs<HTMLElement>(section, "h2")
      : integration === target
        ? qs<HTMLButtonElement>(integration, ".integration-card__header")
        : target instanceof HTMLDetailsElement
          ? qs<HTMLElement>(target, ":scope > summary")
          : target
    const focusTarget = destination && !destination.matches(":disabled") && destination.getClientRects().length
      ? destination
      : qs<HTMLElement>(section, "h2")
    if (!focusTarget) return

    if (!focusTarget.matches("a[href], button, input, select, summary, textarea, [tabindex]")) {
      focusTarget.tabIndex = -1
    }
    focusTarget.dataset.settingsDestination = ""
    focusTarget.focus({ preventScroll: true })
    if (target === section) {
      window.scrollTo({ top: 0, behavior: "instant" })
    } else {
      focusTarget.scrollIntoView({ block: "nearest", behavior: "instant" })
    }
  }

  pageLifecycle.on(toggle, "click", () => {
    setDirectoryOpen(toggle.getAttribute("aria-expanded") !== "true")
  })

  pageLifecycle.on(document, "keydown", (event) => {
    if (!(event instanceof KeyboardEvent) || event.key !== "Escape" || directory.hidden) return
    if (document.activeElement !== toggle && !directory.contains(document.activeElement)) return
    event.preventDefault()
    setDirectoryOpen(false)
    toggle.focus()
  })

  function setSettingsCardOpen(card: HTMLElement, open: boolean): void {
    const body = qs<HTMLElement>(card, ":scope > [data-settings-card-body]")
    const primaryToggle = qs<HTMLButtonElement>(card, ":scope > .settings-panel-card__header .settings-panel-card__toggle")
    card.toggleAttribute("data-card-collapsed", !open)
    if (!open) card.dataset.cardCollapsed = "true"
    else delete card.dataset.cardCollapsed
    if (body) body.hidden = !open
    if (primaryToggle) setAttr(primaryToggle, "aria-expanded", String(open))
  }

  pageLifecycle.on(shell, "click", (event) => {
    const cardToggle = (event.target as Element | null)?.closest<HTMLElement>("[data-settings-card-toggle]")
    if (cardToggle) {
      const card = cardToggle.closest<HTMLElement>("[data-settings-card]")
      if (card) {
        event.preventDefault()
        setSettingsCardOpen(card, card.dataset.cardCollapsed === "true")
      }
      return
    }
    if (!(event instanceof MouseEvent) || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    const link = (event.target as Element | null)?.closest<HTMLAnchorElement>('a[href^="#"][data-settings-nav], a[href^="#"][data-settings-section-link]')
    if (!link) return
    event.preventDefault()
    if (location.hash !== link.hash) history.pushState(history.state, "", link.hash)
    showDestination(link.hash, true)
    saveNavigationState()
  })

  pageLifecycle.on(window, "hashchange", () => showDestination(location.hash, true))
  pageLifecycle.on(shell, "meitheal:settings-ready", () => {
    if (document.activeElement === document.body) showDestination(location.hash, true)
  })
  pageLifecycle.on(shell, "meitheal:settings-jump", () => showDestination(location.hash, true))

  pageLifecycle.on(narrow, "change", () => {
    if (narrow.matches && directory.contains(document.activeElement)) toggle.focus()
    setDirectoryOpen(!narrow.matches)
  })

  setDirectoryOpen(!narrow.matches)
  showDestination(location.hash, true)
  initUnifiedBarSearchLauncher("settings-bar")
  initCompanionLinks()
  initGoToTop()
}
