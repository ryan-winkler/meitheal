import { expect, test } from "@playwright/test"
import { applyAppearancePreferences, bindAppearanceNavigation, readAppearancePreferences } from "../../apps/web/src/lib/appearance-preferences"
import type { AppearancePreferences } from "../../apps/web/src/lib/appearance-preferences"

// Model ownership and lifecycle only. Browser specs cover native focus and layout.
class FixtureElement extends EventTarget {
  readonly dataset: Record<string, string> = {}
  readonly attributes = new Map<string, string>()
  readonly classes = new Set<string>()
  readonly classList = {
    contains: (name: string) => this.classes.has(name),
    toggle: (name: string, force: boolean) => {
      if (force) this.classes.add(name)
      else this.classes.delete(name)
    },
  }
  parentElement: FixtureElement | null = null
  hidden = false
  inert = false
  layout = true
  visibility = "visible"
  hovered = false
  open = true

  constructor(readonly id = "") { super() }

  setAttribute(name: string, value: string) {
    this.attributes.set(name, value)
    if (name.startsWith("data-")) {
      this.dataset[name.slice(5).replace(/-([a-z])/g, (_match, letter: string) => letter.toUpperCase())] = value
    }
  }

  contains(target: unknown): boolean {
    return target instanceof FixtureElement && (target === this || this.contains(target.parentElement))
  }

  closest(selector: string): FixtureElement | null {
    if (selector === "[data-sidebar-board-owner]" && "sidebarBoardOwner" in this.dataset) return this
    if (selector === "[hidden], [inert]" && (this.hidden || this.inert)) return this
    return this.parentElement?.closest(selector) ?? null
  }

  getClientRects() { return this.layout ? [{}] : [] }
  matches(selector: string) { return selector === ":hover" && this.hovered }
}

async function withNavigation(run: (fixture: ReturnType<typeof createNavigation>) => Promise<void> | void) {
  const fixture = createNavigation()
  const globals: Record<string, unknown> = {
    window: fixture.window,
    document: fixture.document,
    localStorage: fixture.storage,
    innerWidth: 1280,
    matchMedia: () => ({ matches: true }),
    getComputedStyle: (element: FixtureElement) => ({ visibility: element.visibility }),
    Node: FixtureElement,
    Element: FixtureElement,
    HTMLElement: FixtureElement,
  }
  const previous = new Map(Object.keys(globals).map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]))
  try {
    for (const [name, value] of Object.entries(globals)) {
      Object.defineProperty(globalThis, name, { configurable: true, writable: true, value })
    }
    await run(fixture)
  } finally {
    fixture.lifecycle.abort()
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor)
      else Reflect.deleteProperty(globalThis, name)
    }
  }
}

function createNavigation() {
  const root = new FixtureElement()
  const body = new FixtureElement()
  const sidebar = new FixtureElement("sidebar")
  const owner = new FixtureElement("sidebar-board-children")
  const edge = new FixtureElement("sidebar-edge-toggle")
  const areasNav = new FixtureElement()
  const group = new FixtureElement("sidebar-areas-group")
  const editor = new FixtureElement()
  const outside = new FixtureElement("outside")
  const popup = new FixtureElement()
  const popupInput = new FixtureElement()
  sidebar.parentElement = body
  owner.parentElement = sidebar
  edge.parentElement = sidebar
  areasNav.parentElement = owner
  group.parentElement = areasNav
  editor.parentElement = group
  outside.parentElement = body
  popup.parentElement = body
  popupInput.parentElement = popup
  popup.dataset.sidebarBoardOwner = owner.id
  const elements = new Map([sidebar, owner, edge, group, outside].map(element => [element.id, element]))
  const document = Object.assign(new EventTarget(), {
    documentElement: root,
    body,
    activeElement: null as unknown,
    getElementById: (id: string) => elements.get(id) ?? null,
    querySelector: (selector: string) => selector === "#sidebar-areas-group" ? group : null,
  })
  const values = new Map<string, string>()
  const storage = {
    getItem: (name: string) => values.get(name) ?? null,
    setItem: (name: string, value: string) => { values.set(name, value) },
  }
  const window = new EventTarget()
  const lifecycle = new AbortController()
  const emit = (receiver: EventTarget, type: string, target: unknown = receiver, values: Record<string, unknown> = {}) => {
    const event = new Event(type, { cancelable: true })
    Object.defineProperty(event, "target", { value: target })
    Object.assign(event, values)
    receiver.dispatchEvent(event)
    return event
  }
  const apply = (changes: Partial<AppearancePreferences> = {}) => applyAppearancePreferences({ ...readAppearancePreferences(), ...changes })
  const expectCollapsed = (collapsed: boolean) => {
    expect(body.classList.contains("sidebar-collapsed")).toBe(collapsed)
    expect(edge.attributes.get("aria-expanded")).toBe(String(!collapsed))
    expect(edge.attributes.get("aria-label")).toBe(collapsed ? "Expand sidebar (Ctrl+B)" : "Collapse sidebar (Ctrl+B)")
  }
  return { root, body, sidebar, owner, edge, group, editor, outside, popup, popupInput, document, window, storage, lifecycle, emit, apply, expectCollapsed }
}

for (const focus of ["sidebar editor", "owned body popup"] as const) {
  test(`appearance changes preserve the expanded rail and Areas disclosure with focus in the ${focus}`, async () => {
    await withNavigation(fixture => {
      fixture.apply()
      fixture.document.activeElement = focus === "sidebar editor" ? fixture.editor : fixture.popupInput
      fixture.apply({ sidebar: "folded", base: "stone" })
      fixture.expectCollapsed(false)
      fixture.apply({ navigation: "navbar" })
      expect(fixture.root.dataset.appearanceNavigation).toBe("navbar")
      expect(fixture.group.open).toBe(true)
      // Rebinding after Astro navigation must also preserve the active disclosure.
      bindAppearanceNavigation(fixture.lifecycle.signal)
      expect(fixture.group.open).toBe(true)
    })
  })
}

const rejectedFocus = [
  "outside editor", "missing popup owner", "owner outside sidebar", "hidden ancestor",
  "inert ancestor", "no layout", "invisible editor", "non-HTMLElement", "no active element",
] as const

for (const reason of rejectedFocus) {
  test(`appearance changes do not preserve rail or disclosure for ${reason}`, async () => {
    await withNavigation(fixture => {
      fixture.apply()
      fixture.document.activeElement = fixture.editor
      if (reason === "outside editor") fixture.document.activeElement = fixture.outside
      if (reason === "missing popup owner") {
        fixture.popup.dataset.sidebarBoardOwner = "missing-board-list"
        fixture.document.activeElement = fixture.popupInput
      }
      if (reason === "owner outside sidebar") {
        fixture.popup.dataset.sidebarBoardOwner = fixture.outside.id
        fixture.document.activeElement = fixture.popupInput
      }
      if (reason === "hidden ancestor") fixture.group.hidden = true
      if (reason === "inert ancestor") fixture.group.inert = true
      if (reason === "no layout") fixture.editor.layout = false
      if (reason === "invisible editor") fixture.editor.visibility = "hidden"
      if (reason === "non-HTMLElement") fixture.document.activeElement = new EventTarget()
      if (reason === "no active element") fixture.document.activeElement = null
      fixture.apply({ sidebar: "folded" })
      fixture.expectCollapsed(true)
      fixture.apply({ navigation: "navbar" })
      fixture.expectCollapsed(false)
      expect(fixture.group.open).toBe(false)
    })
  })
}

test("appearance changes respect an explicit collapse even while its editor retains focus", async () => {
  await withNavigation(fixture => {
    fixture.apply()
    fixture.document.activeElement = fixture.editor
    bindAppearanceNavigation(fixture.lifecycle.signal)
    fixture.emit(fixture.edge, "click")
    fixture.expectCollapsed(true)
    expect(fixture.storage.getItem("meitheal_sidebar_collapsed")).toBe("true")
    fixture.apply({ sidebar: "hover", font: "serif" })
    fixture.expectCollapsed(true)
  })
})

test("hover expansion follows focus into an owned popup and collapses after focus leaves it", async () => {
  await withNavigation(async fixture => {
    fixture.apply({ sidebar: "hover" })
    bindAppearanceNavigation(fixture.lifecycle.signal)
    fixture.expectCollapsed(true)
    fixture.document.activeElement = fixture.editor
    fixture.emit(fixture.sidebar, "focusin", fixture.editor)
    fixture.expectCollapsed(false)
    fixture.emit(fixture.document, "focusout", fixture.editor)
    fixture.document.activeElement = fixture.popupInput
    fixture.emit(fixture.document, "focusin", fixture.popupInput)
    fixture.emit(fixture.sidebar, "pointerleave")
    await Promise.resolve()
    fixture.expectCollapsed(false)
    fixture.emit(fixture.document, "focusout", fixture.popupInput)
    fixture.document.activeElement = fixture.outside
    await Promise.resolve()
    fixture.expectCollapsed(true)
  })
})

for (const reason of ["unowned", "hidden", "no layout", "invisible"] as const) {
  test(`hover ignores ${reason} popup focus`, async () => {
    await withNavigation(async fixture => {
      fixture.apply({ sidebar: "hover" })
      bindAppearanceNavigation(fixture.lifecycle.signal)
      if (reason === "unowned") fixture.popup.dataset.sidebarBoardOwner = fixture.outside.id
      if (reason === "hidden") fixture.popup.hidden = true
      if (reason === "no layout") fixture.popup.layout = false
      if (reason === "invisible") fixture.popup.visibility = "hidden"
      fixture.document.activeElement = fixture.popupInput
      fixture.emit(fixture.document, "focusin", fixture.popupInput)
      fixture.expectCollapsed(true)
      // A stale invisible portal cannot hold an already expanded rail open either.
      fixture.sidebar.hovered = true
      fixture.emit(fixture.sidebar, "pointermove", fixture.owner, { pointerType: "mouse" })
      fixture.expectCollapsed(false)
      fixture.sidebar.hovered = false
      fixture.emit(fixture.sidebar, "pointerleave")
      fixture.expectCollapsed(true)
      fixture.emit(fixture.document, "focusout", fixture.outside)
      await Promise.resolve()
      fixture.expectCollapsed(true)
    })
  })
}

test("manual collapse suppresses the current pointer and popup focus until those inputs leave", async () => {
  await withNavigation(async fixture => {
    fixture.apply({ sidebar: "hover" })
    bindAppearanceNavigation(fixture.lifecycle.signal)
    fixture.sidebar.hovered = true
    fixture.emit(fixture.sidebar, "pointermove", fixture.owner, { pointerType: "mouse" })
    fixture.expectCollapsed(false)
    fixture.document.activeElement = fixture.popupInput
    fixture.emit(fixture.edge, "click")
    fixture.emit(fixture.sidebar, "pointermove", fixture.owner, { pointerType: "mouse" })
    fixture.emit(fixture.document, "focusin", fixture.popupInput)
    fixture.expectCollapsed(true)
    fixture.sidebar.hovered = false
    fixture.emit(fixture.sidebar, "pointerleave")
    fixture.emit(fixture.document, "focusout", fixture.popupInput)
    fixture.document.activeElement = fixture.outside
    await Promise.resolve()
    fixture.document.activeElement = fixture.popupInput
    fixture.emit(fixture.document, "focusin", fixture.popupInput)
    fixture.expectCollapsed(false)
    fixture.lifecycle.abort()
    fixture.emit(fixture.edge, "click")
    fixture.expectCollapsed(false)
  })
})

test("navbar Areas disclosure treats its owned popup as inside and unrelated popups as outside", async () => {
  await withNavigation(fixture => {
    fixture.apply({ navigation: "navbar" })
    bindAppearanceNavigation(fixture.lifecycle.signal)
    fixture.group.open = true
    fixture.emit(fixture.document, "click", fixture.popupInput)
    expect(fixture.group.open).toBe(true)
    fixture.emit(fixture.document, "click", fixture.editor)
    expect(fixture.group.open).toBe(true)

    // Being another Sidebar descendant is insufficient: the owner must contain Areas.
    for (const owner of [fixture.edge.id, fixture.outside.id, "missing-board-list", ""]) {
      fixture.group.open = true
      fixture.popup.dataset.sidebarBoardOwner = owner
      fixture.emit(fixture.document, "click", fixture.popupInput)
      expect(fixture.group.open).toBe(false)
    }
    fixture.group.open = true
    fixture.emit(fixture.document, "click", fixture.outside)
    expect(fixture.group.open).toBe(false)
  })
})

test("navbar Areas only consumes an unhandled Escape from inside its navigation", async () => {
  await withNavigation(fixture => {
    fixture.apply({ navigation: "navbar" })
    bindAppearanceNavigation(fixture.lifecycle.signal)
    fixture.group.open = true

    // An inner editor has already consumed Escape to dismiss its own UI.
    const consumed = new Event("keydown", { cancelable: true })
    Object.defineProperty(consumed, "target", { value: fixture.editor })
    Object.assign(consumed, { key: "Escape" })
    consumed.preventDefault()
    fixture.document.dispatchEvent(consumed)
    expect(fixture.group.open).toBe(true)

    const outside = fixture.emit(fixture.document, "keydown", fixture.outside, { key: "Escape" })
    expect(fixture.group.open).toBe(true)
    expect(outside.defaultPrevented).toBe(false)
    const enter = fixture.emit(fixture.document, "keydown", fixture.editor, { key: "Enter" })
    expect(fixture.group.open).toBe(true)
    expect(enter.defaultPrevented).toBe(false)

    const escape = fixture.emit(fixture.document, "keydown", fixture.editor, { key: "Escape" })
    expect(fixture.group.open).toBe(false)
    expect(escape.defaultPrevented).toBe(true)
  })
})
