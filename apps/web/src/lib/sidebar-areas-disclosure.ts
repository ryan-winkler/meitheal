/** Keep the whole Areas menu disclosure local to this browser. */
interface AreasDisclosureBinding {
  node: HTMLDetailsElement
  signal: AbortSignal
  cleanup(): void
}

export function initSidebarAreasDisclosure(signal: AbortSignal): void {
  const node = document.querySelector<HTMLDetailsElement>("#sidebar-areas-group")
  if (!node || signal.aborted) return
  const runtime = window as typeof window & { __meithealAreasDisclosure?: AreasDisclosureBinding }
  const previous = runtime.__meithealAreasDisclosure
  if (previous?.node === node && previous.signal === signal) return
  previous?.cleanup()

  const key = "meitheal_project_nav_group_collapsed"
  const navbar = () => innerWidth > 768 && document.documentElement.dataset.appearanceNavigation === "navbar"
  const syncTitle = () => {
    const summary = node.querySelector<HTMLElement>("#project-nav-group-toggle")
    if (summary) summary.title = node.open ? "Collapse Areas" : "Expand Areas"
  }
  try { node.open = !navbar() && localStorage.getItem(key) !== "true" } catch { node.open = !navbar() }
  syncTitle()
  const save = () => {
    syncTitle()
    if (navbar()) return
    try { localStorage.setItem(key, String(!node.open)) } catch { /* Keep the current page usable. */ }
  }
  node.addEventListener("toggle", save, { signal })
  const binding: AreasDisclosureBinding = {
    node, signal, cleanup: () => node.removeEventListener("toggle", save),
  }
  runtime.__meithealAreasDisclosure = binding
  signal.addEventListener("abort", () => {
    if (runtime.__meithealAreasDisclosure === binding) delete runtime.__meithealAreasDisclosure
  }, { once: true })
}
