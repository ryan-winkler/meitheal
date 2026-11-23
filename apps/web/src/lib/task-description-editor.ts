import { createSpriteIconElement, type IconName } from "../generated/icon-registry"

/** Shared accessible Markdown / Visual (HugeRTE) / Preview description editor enhancer. */

export type DescriptionEditorMode = "markdown" | "visual" | "preview"

export interface DescriptionEditorHandle {
  syncFromTextarea: () => void
  flushToTextarea: () => void
  setMode: (mode: DescriptionEditorMode, focus?: boolean) => Promise<void>
}

export interface MarkdownPreviewRenderOptions {
  afterRender?: (container: HTMLElement) => void
  shouldApply?: () => boolean
}

interface EditorOptions {
  signal: AbortSignal
  afterPreviewRender?: (container: HTMLElement) => void
}

interface HugeRteEditorInstance {
  getContent: (opts?: { format?: string }) => string
  setContent: (content: string) => void
  getBody?: () => HTMLElement | null
  on: (event: string, cb: () => void) => void
  destroy: () => void
  focus?: () => void
  removed?: boolean
}

interface HugeRteGlobal {
  init: (config: Record<string, unknown>) => Promise<HugeRteEditorInstance[]>
}

interface HistorySnapshot {
  value: string
  start: number
  end: number
}

const HUGERTE_PLUGINS = "advlist autolink lists link code codesample table"
const HUGERTE_TOOLBAR =
  "undo redo | blocks | bold italic strikethrough backcolor | bullist numlist outdent indent | blockquote link code codesample table | removeformat"

let hugeRteLoadPromise: Promise<HugeRteGlobal | null> | null = null

const getHugeRteBaseUrl = () =>
  `${((window as Window & { __ingress_path?: string }).__ingress_path || "").replace(/\/+$/, "")}/vendor/hugerte`

function isDarkThemeActive(): boolean {
  const root = document.documentElement
  if (root.classList.contains("light") || root.dataset.theme === "light") return false
  if (root.classList.contains("dark") || root.dataset.theme === "dark") return true
  return window.matchMedia?.("(prefers-color-scheme: dark)")?.matches ?? true
}

function readEditorThemeVars(anchor: HTMLElement): string {
  const doc = getComputedStyle(document.documentElement)
  const fs = getComputedStyle(anchor)
  const bg = fs.backgroundColor && fs.backgroundColor !== "rgba(0, 0, 0, 0)"
    ? fs.backgroundColor
    : doc.getPropertyValue("--bg-input").trim() || "#111827"
  const fg = fs.color || doc.getPropertyValue("--text-primary").trim() || "#f9fafb"
  const muted = doc.getPropertyValue("--text-muted").trim() || "#9ca3af"
  const accent = doc.getPropertyValue("--accent").trim() || "#f59e0b"
  const border = doc.getPropertyValue("--border").trim() || "rgba(255,255,255,0.12)"
  return `html,body{background:${bg};color:${fg};font-family:${fs.fontFamily || "inherit"};font-size:14px;line-height:1.55;margin:10px 12px}` +
    `a{color:${accent}}blockquote{border-left:3px solid ${accent};color:${muted};margin:.6em 0;padding-left:.85em}` +
    `pre,code{background:rgba(128,128,128,.14);border-radius:4px;font-family:ui-monospace,monospace}pre{padding:8px 10px;overflow-x:auto}` +
    `code{padding:1px 4px}table{border-collapse:collapse;width:100%;margin:.5em 0}th,td{border:1px solid ${border};padding:4px 8px;text-align:left}` +
    `ul,ol{margin:.45em 0;padding-left:1.45em}ul{list-style-type:disc}ol{list-style-type:decimal}p{margin:0 0 .5em}`
}

function loadHugeRte(): Promise<HugeRteGlobal | null> {
  const win = window as Window & { hugeRTE?: HugeRteGlobal }
  if (win.hugeRTE) return Promise.resolve(win.hugeRTE)
  if (hugeRteLoadPromise) return hugeRteLoadPromise
  hugeRteLoadPromise = new Promise(resolve => {
    const scriptUrl = `${getHugeRteBaseUrl()}/hugerte.min.js`
    const existing = document.querySelector<HTMLScriptElement>(`script[data-hugerte-src="${scriptUrl}"]`)
    if (existing) {
      existing.addEventListener("load", () => resolve(win.hugeRTE ?? null), { once: true })
      existing.addEventListener("error", () => { hugeRteLoadPromise = null; resolve(null) }, { once: true })
      return
    }
    const s = document.createElement("script")
    s.src = scriptUrl
    s.async = true
    s.dataset.hugerteSrc = scriptUrl
    s.onload = () => resolve(win.hugeRTE ?? null)
    s.onerror = () => { hugeRteLoadPromise = null; s.remove(); resolve(null) }
    document.head.appendChild(s)
  })
  return hugeRteLoadPromise
}

export async function renderMarkdownPreviewInto(
  target: HTMLElement,
  md: string,
  options: MarkdownPreviewRenderOptions = {},
): Promise<boolean> {
  const { afterRender, shouldApply } = options
  if (!md.trim()) {
    if (shouldApply && !shouldApply()) return false
    const p = document.createElement("p")
    const empty = document.createElement("em")
    empty.className = "text-text-muted"
    empty.textContent = "No description provided."
    p.append(empty)
    target.replaceChildren(p)
    return true
  }
  const [{ renderMarkdownToHtml }, { sanitizeClient }] = await Promise.all([
    import("@lib/markdown-client"),
    import("@lib/sanitize-client"),
  ])
  if (shouldApply && !shouldApply()) return false
  const parsed = new DOMParser().parseFromString(sanitizeClient(renderMarkdownToHtml(md)), "text/html")
  afterRender?.(parsed.body)
  target.replaceChildren(...Array.from(parsed.body.childNodes))
  return true
}

function serializeInlineCode(raw: string): string {
  let maxRun = 0
  let cur = 0
  for (let i = 0; i < raw.length; i++) {
    cur = raw[i] === "`" ? cur + 1 : 0
    if (cur > maxRun) maxRun = cur
  }
  const fence = "`".repeat(maxRun + 1)
  const pad = raw.startsWith("`") || raw.endsWith("`") || (raw.length > 0 && raw.trim().length === 0)
  return pad ? `${fence} ${raw} ${fence}` : `${fence}${raw}${fence}`
}

function serializeTable(table: HTMLTableElement, depth: number): string {
  const rows = Array.from(table.querySelectorAll("tr")).map(tr =>
    Array.from(tr.querySelectorAll("th, td")).map(cell =>
      serializeChildren(cell, depth).replace(/\s*\n+\s*/g, " ").replace(/\|/g, "\\|").trim(),
    ),
  )
  if (!rows[0]?.length) return ""
  const cols = Math.max(...rows.map(r => r.length))
  const pad = (r: string[]) => Array.from({ length: cols }, (_, i) => r[i] ?? "")
  const row = (r: string[]) => `| ${pad(r).join(" | ")} |`
  return `\n${[row(rows[0]!), row(Array.from({ length: cols }, () => "---")), ...rows.slice(1).map(row)].join("\n")}\n\n`
}

const hasLossyStructure = (md: string) => /^(?:```|~~~)/m.test(md) || /<[a-z][^>]*>/i.test(md)

function serializeListItemChildren(li: HTMLLIElement, depth: number): { inline: string; nested: string } {
  const inline: string[] = []
  const nested: string[] = []
  for (const child of Array.from(li.childNodes)) {
    if (child.nodeType === Node.ELEMENT_NODE) {
      const el = child as HTMLElement
      const tag = el.tagName.toLowerCase()
      if (tag === "ul" || tag === "ol") { nested.push(serializeListElement(el, depth + 1).replace(/\n+$/, "")); continue }
      if (tag === "p") { const t = serializeChildren(el, depth).trim(); if (t) inline.push(t); continue }
    }
    inline.push(serializeNode(child, depth))
  }
  return { inline: inline.join("").trim(), nested: nested.filter(Boolean).join("\n") }
}

function serializeListElement(listEl: HTMLElement, depth: number): string {
  const ol = listEl.tagName.toLowerCase() === "ol"
  const indent = "  ".repeat(depth)
  const items = Array.from(listEl.children).filter(c => c.tagName.toLowerCase() === "li").map((node, idx) => {
    const li = node as HTMLLIElement
    const check = li.querySelector(":scope > .md-check")
    const { inline, nested } = serializeListItemChildren(li, depth)
    let prefix = ol ? `${idx + 1}.` : "-"
    let text = inline
    if (check) {
      text = text.replace(/^[☑☐]\s*/, "")
      prefix = `${prefix} [${check.textContent?.includes("☑") ? "x" : " "}]`
    }
    const line = `${indent}${prefix} ${text.trim()}`.replace(/[ \t]+$/, "")
    return nested ? `${line}\n${nested}` : line
  })
  return `${items.join("\n")}${depth === 0 ? "\n\n" : "\n"}`
}

const serializeChildren = (node: Node, depth = 0) => Array.from(node.childNodes).map(c => serializeNode(c, depth)).join("")

export const domToMarkdown = (root: Node) => serializeChildren(root).replace(/\n{3,}/g, "\n\n").trimEnd()

function serializeNode(node: Node, depth = 0): string {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? ""
  if (node.nodeType !== Node.ELEMENT_NODE) return ""
  const el = node as HTMLElement
  const tag = el.tagName.toLowerCase()
  if (tag === "ul" || tag === "ol") return serializeListElement(el, depth)
  const inner = serializeChildren(el, depth)
  switch (tag) {
    case "br": return el.parentElement?.childNodes.length === 1 && el.parentElement.tagName.toLowerCase() === "p" ? "" : "\n"
    case "hr": return "\n---\n\n"
    case "strong": case "b": return inner ? `**${inner}**` : ""
    case "em": case "i": return inner ? `*${inner}*` : ""
    case "del": case "s": case "strike": return inner ? `~~${inner}~~` : ""
    case "code": return el.parentElement?.tagName.toLowerCase() === "pre" ? (el.textContent ?? "") : serializeInlineCode(el.textContent ?? "")
    case "pre": return `\n\`\`\`\n${(el.textContent ?? "").replace(/\n$/, "")}\n\`\`\`\n\n`
    case "table": return serializeTable(el as HTMLTableElement, depth)
    case "a": { const h = el.getAttribute("href") ?? ""; return h ? `[${inner || h}](${h})` : inner }
    case "img": { const src = el.getAttribute("src")?.trim() ?? "", alt = el.getAttribute("alt")?.trim() ?? ""; return src ? `![${alt}](${src})` : alt }
    case "blockquote": return inner.trim().split("\n").map(l => `> ${l}`).join("\n") + "\n\n"
    case "li": return `${inner.trim()}\n`
    case "p": case "div": return inner ? `${inner.replace(/\n+$/, "")}\n\n` : ""
    default: return /^h[1-6]$/.test(tag) ? `${"#".repeat(Number(tag[1]))} ${inner.trim()}\n\n` : inner
  }
}

type ListKind = "ul" | "ol" | "task"

function classifyListLine(line: string): { kind: ListKind | null; indent: string; body: string } {
  let m = line.match(/^(\s*)[-*+]\s+\[[ xX]\]\s*(.*)$/)
  if (m) return { kind: "task", indent: m[1] ?? "", body: m[2] ?? "" }
  m = line.match(/^(\s*)[-*+]\s+(.*)$/)
  if (m) return { kind: "ul", indent: m[1] ?? "", body: m[2] ?? "" }
  m = line.match(/^(\s*)\d+\.\s+(.*)$/)
  if (m) return { kind: "ol", indent: m[1] ?? "", body: m[2] ?? "" }
  const i = line.match(/^(\s*)(.*)$/)
  return { kind: null, indent: i?.[1] ?? "", body: i?.[2] ?? line }
}

function getSelectedLineSpan(ta: HTMLTextAreaElement) {
  const val = ta.value
  const lineStart = val.lastIndexOf("\n", Math.max(0, (ta.selectionStart ?? 0) - 1)) + 1
  const lineEndRaw = val.indexOf("\n", ta.selectionEnd ?? 0)
  const lineEnd = lineEndRaw === -1 ? val.length : lineEndRaw
  return { lineStart, lineEnd, lines: val.slice(lineStart, lineEnd).split("\n") }
}

function commitTextareaEdit(ta: HTMLTextAreaElement, nextValue: string, start: number, end: number, record: () => void): void {
  record()
  ta.value = nextValue
  ta.focus()
  ta.setSelectionRange(start, end)
  record()
  ta.dispatchEvent(new Event("input", { bubbles: true }))
}

function wrapSelection(ta: HTMLTextAreaElement, before: string, after: string, fallback: string, record: () => void): void {
  const s = ta.selectionStart ?? ta.value.length
  const e = ta.selectionEnd ?? ta.value.length
  const sel = ta.value.slice(s, e) || fallback
  commitTextareaEdit(ta, ta.value.slice(0, s) + before + sel + after + ta.value.slice(e), s + before.length, s + before.length + sel.length, record)
}

function toggleLinePrefix(ta: HTMLTextAreaElement, prefix: string, record: () => void): void {
  const { lineStart, lineEnd, lines } = getSelectedLineSpan(ta)
  const all = lines.every(l => l.startsWith(prefix))
  const block = lines.map(l => (all ? l.slice(prefix.length) : `${prefix}${l}`)).join("\n")
  commitTextareaEdit(ta, ta.value.slice(0, lineStart) + block + ta.value.slice(lineEnd), lineStart, lineStart + block.length, record)
}

function toggleLineList(ta: HTMLTextAreaElement, kind: ListKind, record: () => void): void {
  const { lineStart, lineEnd, lines } = getSelectedLineSpan(ta)
  const parsed = lines.map(classifyListLine)
  const relevant = parsed.filter((_, i) => parsed.length === 1 || lines[i]!.trim().length > 0)
  const allMatch = relevant.length > 0 && relevant.every(p => p.kind === kind)
  let n = 1
  const block = parsed.map((p, idx) => {
    if (lines.length > 1 && !lines[idx]!.trim()) return lines[idx]!
    if (allMatch) return `${p.indent}${p.body}`
    if (kind === "ul") return `${p.indent}- ${p.body}`
    if (kind === "task") return `${p.indent}- [ ] ${p.body}`
    return `${p.indent}${n++}. ${p.body}`
  }).join("\n")
  const end = lineStart + block.length
  commitTextareaEdit(ta, ta.value.slice(0, lineStart) + block + ta.value.slice(lineEnd), end, end, record)
}

function indentSelection(ta: HTMLTextAreaElement, delta: 2 | -2, record: () => void): void {
  const { lineStart, lineEnd, lines } = getSelectedLineSpan(ta)
  const block = lines.map(l => delta > 0 ? (l || lines.length === 1 ? `  ${l}` : l) : l.startsWith("  ") ? l.slice(2) : l.replace(/^(?:\t| )/, "")).join("\n")
  commitTextareaEdit(ta, ta.value.slice(0, lineStart) + block + ta.value.slice(lineEnd), lineStart, lineStart + block.length, record)
}

function clearMarkdownFormatting(ta: HTMLTextAreaElement, record: () => void): void {
  const s = ta.selectionStart ?? 0, e = ta.selectionEnd ?? ta.value.length
  const ts = e > s ? s : 0, te = e > s ? e : ta.value.length
  const cleaned = ta.value.slice(ts, te).split("\n").map(line => {
    const p = classifyListLine(line)
    return (p.kind ? `${p.indent}${p.body}` : line)
      .replace(/^\s{0,3}#{1,6}\s+/, "").replace(/^\s*>\s?/, "")
      .replace(/\*\*([^*]+)\*\*/g, "$1").replace(/\*([^*]+)\*/g, "$1")
      .replace(/~~([^~]+)~~/g, "$1").replace(/`([^`]+)`/g, "$1").replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
  }).join("\n")
  commitTextareaEdit(ta, ta.value.slice(0, ts) + cleaned + ta.value.slice(te), ts, ts + cleaned.length, record)
}

export function enhanceDescriptionEditor(
  textarea: HTMLTextAreaElement | null,
  options: EditorOptions,
): DescriptionEditorHandle | null {
  if (!textarea || textarea.dataset.mdEnhanced === "ready") return null
  const field = textarea
  field.dataset.mdEnhanced = "ready"
  const { signal, afterPreviewRender } = options

  const history: HistorySnapshot[] = [{ value: field.value, start: field.selectionStart ?? 0, end: field.selectionEnd ?? 0 }]
  let historyIdx = 0
  let applyingHistory = false

  function recordSnapshot(): void {
    if (applyingHistory) return
    const snap = { value: field.value, start: field.selectionStart ?? field.value.length, end: field.selectionEnd ?? field.value.length }
    if (history[historyIdx]?.value === snap.value) return
    history.splice(historyIdx + 1)
    history.push(snap)
    if (history.length > 60) history.shift()
    historyIdx = history.length - 1
  }

  function applyHistoryDelta(delta: -1 | 1): void {
    const snap = history[historyIdx + delta]
    if (!snap) return
    historyIdx += delta
    applyingHistory = true
    field.value = snap.value
    field.focus()
    field.setSelectionRange(snap.start, snap.end)
    field.dispatchEvent(new Event("input", { bubbles: true }))
    applyingHistory = false
  }

  type ToolDef = readonly [string, string, IconName, (ta: HTMLTextAreaElement) => void]
  const toolbarGroups: readonly (readonly ToolDef[])[] = [
    [["undo", "Undo", "arrow-back-up", () => applyHistoryDelta(-1)], ["redo", "Redo", "arrow-forward-up", () => applyHistoryDelta(1)]],
    [
      ["bold", "Bold", "bold", ta => wrapSelection(ta, "**", "**", "bold text", recordSnapshot)],
      ["italic", "Italic", "italic", ta => wrapSelection(ta, "*", "*", "italic text", recordSnapshot)],
      ["strike", "Strikethrough", "strikethrough", ta => wrapSelection(ta, "~~", "~~", "text", recordSnapshot)],
      ["code", "Inline code", "code", ta => wrapSelection(ta, "`", "`", "code", recordSnapshot)],
    ],
    [
      ["ul", "Bullet list", "list", ta => toggleLineList(ta, "ul", recordSnapshot)],
      ["ol", "Numbered list", "list-numbers", ta => toggleLineList(ta, "ol", recordSnapshot)],
      ["task", "Task item", "list-check", ta => toggleLineList(ta, "task", recordSnapshot)],
      ["outdent", "Decrease indent", "indent-decrease", ta => indentSelection(ta, -2, recordSnapshot)],
      ["indent", "Increase indent", "indent-increase", ta => indentSelection(ta, 2, recordSnapshot)],
    ],
    [
      ["quote", "Quote", "blockquote", ta => toggleLinePrefix(ta, "> ", recordSnapshot)],
      ["link", "Link", "link", ta => wrapSelection(ta, "[", "](https://example.com)", "link text", recordSnapshot)],
      ["codeblock", "Code block", "braces", ta => wrapSelection(ta, "\n```\n", "\n```\n", "code block", recordSnapshot)],
      ["clear", "Clear formatting", "clear-formatting", ta => clearMarkdownFormatting(ta, recordSnapshot)],
    ],
  ]

  const frame = document.createElement("div")
  frame.className = "md-editor-frame"
  const header = document.createElement("div")
  header.className = "md-editor-header"
  const toolbar = document.createElement("div")
  toolbar.className = "md-editor-toolbar"
  toolbar.setAttribute("role", "toolbar")
  toolbar.setAttribute("aria-label", "Formatting tools")

  toolbarGroups.forEach((group, gi) => {
    if (gi > 0) {
      const sep = document.createElement("span")
      sep.className = "md-toolbar-sep"
      sep.setAttribute("aria-hidden", "true")
      toolbar.appendChild(sep)
    }
    const gEl = document.createElement("div")
    gEl.className = "md-toolbar-group"
    for (const [id, label, icon, run] of group) {
      const btn = document.createElement("button")
      btn.type = "button"
      btn.className = "md-tool-btn"
      btn.dataset.mdAction = id
      btn.title = label
      btn.setAttribute("aria-label", label)
      btn.appendChild(createSpriteIconElement(icon, { size: 16 }))
      btn.addEventListener("click", () => { if (currentMode !== "markdown") void setMode("markdown"); run(field) }, { signal })
      gEl.appendChild(btn)
    }
    toolbar.appendChild(gEl)
  })

  const visualStatusHint = document.createElement("span")
  visualStatusHint.className = "md-editor-mode-label"
  visualStatusHint.hidden = true

  const modesWrap = document.createElement("div")
  modesWrap.className = "md-editor-modes"
  modesWrap.setAttribute("role", "tablist")
  modesWrap.setAttribute("aria-label", "Description editor mode")

  const baseId = field.id || `md-editor-${Math.random().toString(36).slice(2, 8)}`
  const modes: readonly DescriptionEditorMode[] = ["visual", "markdown", "preview"]
  const panelIds: Record<DescriptionEditorMode, string> = {
    visual: `${baseId}-panel-visual`, markdown: `${baseId}-panel-markdown`, preview: `${baseId}-panel-preview`,
  }

  const visual = document.createElement("div")
  visual.id = panelIds.visual
  visual.className = "md-visual-surface"
  visual.setAttribute("role", "tabpanel")
  visual.hidden = true
  visual.setAttribute("aria-label", field.getAttribute("aria-label") || "Visual description editor")

  const preview = document.createElement("div")
  preview.id = panelIds.preview
  preview.className = "prose md-preview-surface wrap-break-word"
  preview.setAttribute("role", "tabpanel")
  preview.hidden = true

  const modeButtons = new Map<DescriptionEditorMode, HTMLButtonElement>()
  for (const [m, text] of [["visual", "Visual"], ["markdown", "Markdown"], ["preview", "Preview"]] as const) {
    const btn = document.createElement("button")
    btn.type = "button"
    btn.id = `${baseId}-tab-${m}`
    btn.role = "tab"
    btn.className = "md-mode-btn"
    btn.dataset.mdMode = m
    btn.textContent = text
    btn.setAttribute("aria-controls", m === "markdown" ? field.id || panelIds.markdown : panelIds[m])
    btn.setAttribute("aria-selected", String(m === "markdown"))
    btn.classList.toggle("active", m === "markdown")
    btn.tabIndex = m === "markdown" ? 0 : -1
    modeButtons.set(m, btn)
    modesWrap.appendChild(btn)
  }
  visual.setAttribute("aria-labelledby", modeButtons.get("visual")!.id)
  preview.setAttribute("aria-labelledby", modeButtons.get("preview")!.id)
  header.append(toolbar, visualStatusHint, modesWrap)

  const notice = document.createElement("p")
  notice.className = "md-editor-notice"
  notice.setAttribute("role", "status")
  notice.hidden = true

  field.parentElement!.insertBefore(frame, field)
  frame.append(header, notice, field, visual, preview)

  let currentMode: DescriptionEditorMode = "markdown"
  let activeHugeRte: HugeRteEditorInstance | null = null
  let fallbackEditable: HTMLDivElement | null = null
  let visualDirty = false
  let syncingFromInit = false
  let lossyLocked = false
  let renderSeq = 0

  function flushVisualToTextarea(force = false): void {
    if (currentMode !== "visual" || lossyLocked || (!force && !visualDirty)) return
    const node = activeHugeRte && !activeHugeRte.removed
      ? new DOMParser().parseFromString(activeHugeRte.getContent(), "text/html").body
      : fallbackEditable
    if (!node) return
    const nextMd = domToMarkdown(node)
    if (nextMd !== field.value) {
      field.value = nextMd
      field.dispatchEvent(new Event("input", { bubbles: true }))
    }
  }

  function destroyVisualInstance(): void {
    try { activeHugeRte?.destroy() } catch { /* ignore teardown noise */ }
    activeHugeRte = null
    fallbackEditable = null
    visual.replaceChildren()
  }

  async function sanitizePastedHtml(html: string, plainFallback: string) {
    const [{ sanitizeClient }] = await Promise.all([import("@lib/sanitize-client")])
    if (signal.aborted) return null
    const doc = new DOMParser().parseFromString(sanitizeClient(html), "text/html")
    const md = domToMarkdown(doc.body) || plainFallback
    return { doc, md }
  }

  async function renderFallbackEditable(md: string, readonly: boolean, seq: number): Promise<void> {
    if (signal.aborted || seq !== renderSeq) return
    const surface = document.createElement("div")
    surface.className = "md-visual-fallback prose"
    surface.contentEditable = readonly ? "false" : "true"
    surface.setAttribute("aria-label", field.getAttribute("aria-label") || "Visual description editor")
    visual.replaceChildren(surface)
    fallbackEditable = surface

    if (!readonly) {
      surface.addEventListener("input", () => {
        if (syncingFromInit || lossyLocked) return
        visualDirty = true
        flushVisualToTextarea(true)
      }, { signal })
      surface.addEventListener("paste", async e => {
        if (lossyLocked || !fallbackEditable) return
        const html = e.clipboardData?.getData("text/html") ?? ""
        if (!html.trim()) return
        e.preventDefault()
        const sel = window.getSelection()
        const range = sel && sel.rangeCount > 0 ? sel.getRangeAt(0).cloneRange() : null
        const pasted = await sanitizePastedHtml(html, e.clipboardData?.getData("text/plain") ?? "")
        if (!pasted || signal.aborted) return
        if (pasted.doc.body.querySelector("table, pre") || hasLossyStructure(pasted.md)) {
          const s = field.selectionStart ?? field.value.length, end = field.selectionEnd ?? field.value.length
          field.setRangeText(pasted.md, s, end, "end")
          field.dispatchEvent(new Event("input", { bubbles: true }))
          await setMode("markdown", true)
          return
        }
        if (range && fallbackEditable.contains(range.commonAncestorContainer)) {
          range.deleteContents()
          const frag = document.createDocumentFragment()
          frag.append(...Array.from(pasted.doc.body.childNodes))
          range.insertNode(frag)
          sel?.removeAllRanges()
          sel?.addRange(range)
          sel?.collapseToEnd()
          visualDirty = true
          flushVisualToTextarea(true)
        }
      }, { signal })
    }

    if (!md.trim()) { surface.replaceChildren(document.createElement("p")); return }
    await renderMarkdownPreviewInto(surface, md, { shouldApply: () => !signal.aborted && seq === renderSeq })
  }

  async function mountHugeRteVisual(md: string, seq: number): Promise<void> {
    destroyVisualInstance()
    lossyLocked = hasLossyStructure(md)
    if (lossyLocked) {
      notice.textContent = "This description uses fenced code blocks or raw HTML that edit safely in Markdown mode."
      notice.hidden = false
      await renderFallbackEditable(md, true, seq)
      return
    }
    const [{ renderMarkdownToHtml }, { sanitizeClient }, hugeRte] = await Promise.all([
      import("@lib/markdown-client"), import("@lib/sanitize-client"), loadHugeRte(),
    ])
    if (signal.aborted || seq !== renderSeq || currentMode !== "visual") return
    const initialHtml = md.trim() ? sanitizeClient(renderMarkdownToHtml(md)) : ""
    if (!hugeRte) { await renderFallbackEditable(md, false, seq); return }

    const target = document.createElement("textarea")
    target.className = "md-hugerte-target"
    target.value = initialHtml
    visual.replaceChildren(target)

    const dark = isDarkThemeActive(), baseUrl = getHugeRteBaseUrl()
    const editors = await hugeRte.init({
      target, base_url: baseUrl, suffix: ".min", menubar: false, statusbar: false, branding: false,
      promotion: false, resize: false, min_height: 180, plugins: HUGERTE_PLUGINS, toolbar: HUGERTE_TOOLBAR,
      toolbar_mode: "sliding", skin: dark ? "oxide-dark" : "oxide",
      skin_url: `${baseUrl}/skins/ui/${dark ? "oxide-dark" : "oxide"}`,
      content_css: `${baseUrl}/skins/content/${dark ? "dark" : "default"}/content.min.css`,
      content_style: readEditorThemeVars(field),
      paste_preprocess: (_p: unknown, args: { content: string }) => { args.content = sanitizeClient(args.content) },
      setup: (editor: HugeRteEditorInstance) => {
        editor.on("init", () => {
          if (signal.aborted || seq !== renderSeq || currentMode !== "visual") return
          syncingFromInit = true
          if (initialHtml) editor.setContent(initialHtml)
          syncingFromInit = false
          visualDirty = false
        })
        editor.on("input change Dirty ExecCommand Paste Cut Undo Redo", () => {
          if (syncingFromInit || signal.aborted || currentMode !== "visual") return
          visualDirty = true
          flushVisualToTextarea(true)
        })
      },
    })
    const mounted = editors[0] ?? null
    if (!mounted || signal.aborted || seq !== renderSeq || currentMode !== "visual") {
      try { mounted?.destroy() } catch { /* ignore teardown race */ }
      if (!mounted && !signal.aborted && seq === renderSeq && currentMode === "visual") await renderFallbackEditable(md, false, seq)
      return
    }
    activeHugeRte = mounted
  }

  async function renderPreview(md: string, seq: number): Promise<void> {
    if (signal.aborted || seq !== renderSeq) return
    if (!md.trim()) {
      const empty = document.createElement("em")
      empty.className = "text-text-muted"
      empty.textContent = "Nothing to preview."
      preview.replaceChildren(empty)
      return
    }
    await renderMarkdownPreviewInto(preview, md, { afterRender: afterPreviewRender, shouldApply: () => !signal.aborted && seq === renderSeq })
  }

  async function setMode(nextMode: DescriptionEditorMode, focus = true): Promise<void> {
    if (currentMode === "visual" && nextMode !== "visual") { flushVisualToTextarea(); destroyVisualInstance() }
    const seq = ++renderSeq
    currentMode = nextMode
    visualDirty = false
    for (const [m, btn] of modeButtons) {
      const sel = m === nextMode
      btn.setAttribute("aria-selected", String(sel))
      btn.tabIndex = sel ? 0 : -1
      btn.classList.toggle("active", sel)
    }
    toolbar.hidden = nextMode !== "markdown"
    visualStatusHint.hidden = nextMode === "markdown"
    visualStatusHint.textContent = nextMode === "visual" ? "Rich text (HugeRTE)" : "Preview"
    field.hidden = nextMode !== "markdown"
    visual.hidden = nextMode !== "visual"
    preview.hidden = nextMode !== "preview"
    notice.hidden = true

    if (nextMode === "visual") {
      await mountHugeRteVisual(field.value, seq)
      if (!lossyLocked && focus && !signal.aborted && seq === renderSeq) activeHugeRte?.removed === false ? activeHugeRte.focus?.() : fallbackEditable?.focus()
    } else if (nextMode === "preview") {
      await renderPreview(field.value, seq)
    } else if (focus) field.focus()
  }

  for (const [m, btn] of modeButtons) btn.addEventListener("click", () => void setMode(m), { signal })

  modesWrap.addEventListener("keydown", e => {
    const idx = modes.findIndex(m => modeButtons.get(m) === document.activeElement)
    if (idx === -1) return
    const nextIdx = e.key === "ArrowRight" ? (idx + 1) % 3 : e.key === "ArrowLeft" ? (idx + 2) % 3 : e.key === "Home" ? 0 : e.key === "End" ? 2 : -1
    if (nextIdx === -1) return
    e.preventDefault()
    const targetMode = modes[nextIdx]!
    modeButtons.get(targetMode)?.focus()
    void setMode(targetMode, false)
  }, { signal })

  let typingTimer: number | null = null
  field.addEventListener("input", () => {
    if (applyingHistory) return
    if (typingTimer !== null) window.clearTimeout(typingTimer)
    typingTimer = window.setTimeout(() => { typingTimer = null; recordSnapshot() }, 350)
  }, { signal })

  field.addEventListener("keydown", e => {
    if (e.defaultPrevented || e.isComposing || field.getAttribute("aria-controls")) return
    if (e.key === "Tab") {
      if (getSelectedLineSpan(field).lines.some(l => classifyListLine(l).kind !== null)) {
        e.preventDefault()
        indentSelection(field, e.shiftKey ? -2 : 2, recordSnapshot)
      }
      return
    }
    if (e.key !== "Enter" || e.shiftKey || e.metaKey || e.ctrlKey || e.altKey) return
    const start = field.selectionStart ?? 0
    if (start !== (field.selectionEnd ?? start)) return
    const val = field.value
    const lineStart = val.lastIndexOf("\n", Math.max(0, start - 1)) + 1
    const lineEndRaw = val.indexOf("\n", start)
    const lineEnd = lineEndRaw === -1 ? val.length : lineEndRaw
    const fullLine = val.slice(lineStart, lineEnd)
    const parsed = classifyListLine(fullLine)
    if (!parsed.kind) return
    e.preventDefault()
    recordSnapshot()
    if (!parsed.body.trim() && val.slice(lineStart, start) === fullLine) {
      field.value = val.slice(0, lineStart) + val.slice(lineEnd)
      field.setSelectionRange(lineStart, lineStart)
      recordSnapshot()
      field.dispatchEvent(new Event("input", { bubbles: true }))
      return
    }
    const nextPrefix = parsed.kind === "task" ? `${parsed.indent}- [ ] `
      : parsed.kind === "ol" ? `${parsed.indent}${Number(fullLine.match(/^\s*(\d+)\./)?.[1] ?? 0) + 1}. `
      : `${parsed.indent}- `
    field.setRangeText(`\n${nextPrefix}`, start, start, "end")
    recordSnapshot()
    field.dispatchEvent(new Event("input", { bubbles: true }))
  }, { signal })

  field.addEventListener("paste", async e => {
    const html = e.clipboardData?.getData("text/html") ?? ""
    if (!html.trim()) return
    const s = field.selectionStart ?? field.value.length, end = field.selectionEnd ?? field.value.length
    e.preventDefault()
    const pasted = await sanitizePastedHtml(html, e.clipboardData?.getData("text/plain") ?? "")
    if (!pasted || signal.aborted) return
    recordSnapshot()
    field.setRangeText(pasted.md, s, end, "end")
    recordSnapshot()
    field.dispatchEvent(new Event("input", { bubbles: true }))
  }, { signal })

  signal.addEventListener("abort", () => {
    if (typingTimer !== null) window.clearTimeout(typingTimer)
    destroyVisualInstance()
    field.hidden = false
    if (frame.parentNode) { frame.parentNode.insertBefore(field, frame); frame.remove() }
    delete field.dataset.mdEnhanced
  }, { once: true })

  return {
    syncFromTextarea: () => {
      const seq = ++renderSeq
      visualDirty = false
      if (currentMode === "visual") void mountHugeRteVisual(field.value, seq)
      else if (currentMode === "preview") void renderPreview(field.value, seq)
    },
    flushToTextarea: () => { flushVisualToTextarea(true) },
    setMode,
  }
}
