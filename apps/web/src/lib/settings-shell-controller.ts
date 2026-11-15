import { pageLifecycle } from "@lib/page-lifecycle"
import {
  buildCompanionNavigateUrl,
  buildCompanionXCallbackUrl,
  buildIngressPagePath,
} from "@lib/page-shell-links"
import { resolveSettingsSectionId, type SettingsSectionId } from "@lib/settings-registry"
import { showToast } from "@lib/toast"
import { initUnifiedBarSearchLauncher } from "@lib/unified-bar-controller"

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
      const preview = container.querySelector<HTMLElement>(
        "[data-companion-xcallback-preview]",
      )
      const copyButton = container.querySelector<HTMLButtonElement>(
        "[data-companion-xcallback-button]",
      )

      if (preview) preview.textContent = xCallbackHref

      if (!copyButton) return
      pageLifecycle.on(copyButton, "click", async () => {
        try {
          await navigator.clipboard.writeText(xCallbackHref)
          showToast("Companion x-callback URL copied", "success")
        } catch {
          showToast("Could not copy the companion URL", "error")
        }
      })
    })
}

function initGoToTop(): void {
  const button = document.getElementById("settings-go-top")
  const marker = document.getElementById("settings-scroll-marker")
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
  const shell = document.getElementById("settings-shell")
  const directory = document.getElementById("settings-directory")
  const toggle = document.getElementById("settings-sections-toggle")
  const panels = document.getElementById("settings-panels")
  if (!shell || !directory || !toggle || !panels) return

  const narrow = window.matchMedia("(max-width: 860px)")
  const sections = panels.querySelectorAll<HTMLElement>("[data-settings-shell-section]")
  const links = directory.querySelectorAll<HTMLAnchorElement>("[data-settings-nav]")

  function setDirectoryOpen(open: boolean): void {
    toggle!.setAttribute("aria-expanded", String(open))
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
    const rawTarget = id ? document.getElementById(id) : null
    const section =
      (aliasedId ? document.getElementById(aliasedId) : null) ??
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
      if (link.dataset.settingsNav === sectionId) link.setAttribute("aria-current", "location")
      else link.removeAttribute("aria-current")
    })
    if (narrow.matches) setDirectoryOpen(false)
    if (!moveFocus || !section || !target) return

    // Reveal parent disclosures in outer-to-inner order before moving focus.
    const integration = target.closest(".integration-card")
    const body = integration?.querySelector<HTMLElement>(".integration-card__body")
    if (body) window.expandIntegrationCard?.(body.id)
    for (let node: HTMLElement | null = target; node && node !== section; node = node.parentElement) {
      if (node instanceof HTMLDetailsElement) node.open = true
    }
    const destination = target === section
      ? section.querySelector<HTMLElement>("h2")
      : integration === target
        ? integration.querySelector<HTMLButtonElement>(".integration-card__header")
        : target instanceof HTMLDetailsElement
          ? target.querySelector<HTMLElement>(":scope > summary")
          : target
    const focusTarget = destination && !destination.matches(":disabled") && destination.getClientRects().length
      ? destination
      : section.querySelector<HTMLElement>("h2")
    if (!focusTarget) return

    if (!focusTarget.matches("a[href], button, input, select, summary, textarea, [tabindex]")) {
      focusTarget.tabIndex = -1
    }
    focusTarget.dataset.settingsDestination = ""
    focusTarget.focus({ preventScroll: true })
    focusTarget.scrollIntoView({ block: "nearest", behavior: "instant" })
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

  pageLifecycle.on(shell, "click", (event) => {
    if (!(event instanceof MouseEvent) || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    const link = (event.target as Element | null)?.closest<HTMLAnchorElement>('a[href^="#"][data-settings-nav], a[href^="#"][data-settings-section-link]')
    if (!link) return
    event.preventDefault()
    if (location.hash !== link.hash) history.pushState(history.state, "", link.hash)
    showDestination(link.hash, true)
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
