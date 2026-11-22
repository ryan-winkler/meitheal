/**
 * Shared accessible Markdown / Visual / Preview description editor enhancer.
 * Keeps the wrapped <textarea> as the authoritative Markdown source of truth,
 * adds a Tabler toolbar and paste firewall, and keeps Markdown `- [ ]` lists
 * strictly isolated from database checklists.
 */

export type DescriptionEditorMode = "markdown" | "visual" | "preview"

export interface DescriptionEditorHandle {
  syncFromTextarea: () => void
  setMode: (mode: DescriptionEditorMode, focus?: boolean) => Promise<void>
}

interface EditorOptions {
  signal: AbortSignal
  afterPreviewRender?: (container: HTMLElement) => void
  defaultMode?: DescriptionEditorMode
}

function hasLossyStructure(md: string): boolean {
  if (/^(?:```|~~~)/m.test(md)) return true
  return /<[a-z][^>]*>/i.test(md) || /^\|.+\|\s*\n\|?\s*:?-{3,}:?/m.test(md)
}

function serializeChildren(node: Node): string {
  return Array.from(node.childNodes).map(serializeNode).join("")
}

export function domToMarkdown(root: Node): string {
  return Array.from(root.childNodes)
    .map(serializeNode)
    .join("")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd()
}

function serializeNode(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? ""
  if (node.nodeType !== Node.ELEMENT_NODE) return ""
  const el = node as HTMLElement
  const tag = el.tagName.toLowerCase()
  const inner = serializeChildren(el)
  switch (tag) {
    case "br": return "\n"
    case "hr": return "\n---\n\n"
    case "strong":
    case "b": return inner ? `**${inner}**` : ""
    case "em":
    case "i": return inner ? `*${inner}*` : ""
    case "del":
    case "s":
    case "strike": return inner ? `~~${inner}~~` : ""
    case "code": {
      if (el.parentElement?.tagName.toLowerCase() === "pre") return el.textContent ?? ""
      return `\`${(el.textContent ?? "").replace(/`/g, "\\`")}\``
    }
    case "pre": return `\n\`\`\`\n${(el.textContent ?? "").replace(/\n$/, "")}\n\`\`\`\n\n`
    case "a": {
      const href = el.getAttribute("href") ?? ""
      return href ? `[${inner || href}](${href})` : inner
    }
    case "h1": return `# ${inner.trim()}\n\n`
    case "h2": return `## ${inner.trim()}\n\n`
    case "h3": return `### ${inner.trim()}\n\n`
    case "h4": return `#### ${inner.trim()}\n\n`
    case "h5": return `##### ${inner.trim()}\n\n`
    case "h6": return `###### ${inner.trim()}\n\n`
    case "blockquote": {
      const lines = inner.trim().split("\n").map(line => `> ${line}`)
      return lines.join("\n") + "\n\n"
    }
    case "ul":
    case "ol": {
      const items = Array.from(el.children)
        .filter(c => c.tagName.toLowerCase() === "li")
        .map((li, idx) => {
          const check = li.querySelector(":scope > .md-check")
          let text = serializeChildren(li)
          if (check) {
            const done = check.textContent?.includes("☑")
            text = text.replace(/^[☑☐]\s*/, "")
            return `${tag === "ol" ? `${idx + 1}.` : "-"} [${done ? "x" : " "}] ${text.trim()}`
          }
          return `${tag === "ol" ? `${idx + 1}.` : "-"} ${text.trim()}`
        })
      return items.join("\n") + "\n\n"
    }
    case "li": return `${inner.trim()}\n`
    case "p":
    case "div": return inner ? `${inner.replace(/\n+$/, "")}\n\n` : ""
    default: return inner
  }
}

function wrapSelection(textarea: HTMLTextAreaElement, before: string, after: string, fallback: string): void {
  const start = textarea.selectionStart ?? textarea.value.length
  const end = textarea.selectionEnd ?? textarea.value.length
  const selected = textarea.value.slice(start, end) || fallback
  const next = textarea.value.slice(0, start) + before + selected + after + textarea.value.slice(end)
  textarea.value = next
  const cursorStart = start + before.length
  const cursorEnd = cursorStart + selected.length
  textarea.focus()
  textarea.setSelectionRange(cursorStart, cursorEnd)
  textarea.dispatchEvent(new Event("input", { bubbles: true }))
}

function prefixLineSelection(textarea: HTMLTextAreaElement, prefix: string): void {
  const start = textarea.selectionStart ?? 0
  const end = textarea.selectionEnd ?? 0
  const val = textarea.value
  const lineStart = val.lastIndexOf("\n", Math.max(0, start - 1)) + 1
  const lineEndRaw = val.indexOf("\n", end)
  const lineEnd = lineEndRaw === -1 ? val.length : lineEndRaw
  const block = val.slice(lineStart, lineEnd)
    .split("\n")
    .map(line => (line.startsWith(prefix) ? line : `${prefix}${line}`))
    .join("\n")
  textarea.value = val.slice(0, lineStart) + block + val.slice(lineEnd)
  textarea.focus()
  textarea.setSelectionRange(lineStart, lineStart + block.length)
  textarea.dispatchEvent(new Event("input", { bubbles: true }))
}

const TOOLBAR_ACTIONS: readonly { id: string; label: string; icon: string; run: (ta: HTMLTextAreaElement) => void }[] = [
  { id: "bold", label: "Bold", icon: "B", run: ta => wrapSelection(ta, "**", "**", "bold text") },
  { id: "italic", label: "Italic", icon: "I", run: ta => wrapSelection(ta, "*", "*", "italic text") },
  { id: "code", label: "Inline code", icon: "</>", run: ta => wrapSelection(ta, "`", "`", "code") },
  { id: "codeblock", label: "Code block", icon: "{ }", run: ta => wrapSelection(ta, "\n```\n", "\n```\n", "code block") },
  { id: "link", label: "Link", icon: "Link", run: ta => wrapSelection(ta, "[", "](https://example.com)", "link text") },
  { id: "ul", label: "Bullet list", icon: "• List", run: ta => prefixLineSelection(ta, "- ") },
  { id: "ol", label: "Numbered list", icon: "1. List", run: ta => prefixLineSelection(ta, "1. ") },
  { id: "task", label: "Task item", icon: "☐ Task", run: ta => prefixLineSelection(ta, "- [ ] ") },
  { id: "quote", label: "Quote", icon: "❝ Quote", run: ta => prefixLineSelection(ta, "> ") },
]

export function enhanceDescriptionEditor(
  textarea: HTMLTextAreaElement | null,
  options: EditorOptions,
): DescriptionEditorHandle | null {
  if (!textarea || textarea.dataset.mdEnhanced === "ready") return null
  const field = textarea
  field.dataset.mdEnhanced = "ready"
  const { signal, afterPreviewRender } = options

  const host = document.createElement("div")
  host.className = "md-editor-chrome"

  const header = document.createElement("div")
  header.className = "md-editor-header"

  const modesWrap = document.createElement("div")
  modesWrap.className = "btn-list md-editor-modes"
  modesWrap.setAttribute("role", "tablist")
  modesWrap.setAttribute("aria-label", "Description editor mode")

  const modeButtons = new Map<DescriptionEditorMode, HTMLButtonElement>()
  for (const [m, text] of [["markdown", "Markdown"], ["visual", "Visual"], ["preview", "Preview"]] as const) {
    const btn = document.createElement("button")
    btn.type = "button"
    btn.role = "tab"
    btn.className = "btn btn-sm md-mode-btn"
    btn.dataset.mdMode = m
    btn.textContent = text
    btn.setAttribute("aria-selected", String(m === "markdown"))
    modeButtons.set(m, btn)
    modesWrap.appendChild(btn)
  }

  const toolbar = document.createElement("div")
  toolbar.className = "btn-list md-editor-toolbar"
  toolbar.setAttribute("aria-label", "Formatting tools")
  for (const action of TOOLBAR_ACTIONS) {
    const btn = document.createElement("button")
    btn.type = "button"
    btn.className = "btn btn-sm btn-ghost md-tool-btn"
    btn.title = action.label
    btn.setAttribute("aria-label", action.label)
    btn.textContent = action.icon
    btn.addEventListener("click", () => {
      if (currentMode !== "markdown") void setMode("markdown")
      action.run(textarea)
    }, { signal })
    toolbar.appendChild(btn)
  }

  header.append(modesWrap, toolbar)

  const notice = document.createElement("p")
  notice.className = "md-editor-notice"
  notice.setAttribute("role", "status")
  notice.hidden = true

  const visual = document.createElement("div")
  visual.className = "form-input md-visual-surface"
  visual.contentEditable = "true"
  visual.hidden = true
  visual.setAttribute("aria-label", textarea.getAttribute("aria-label") || "Visual description editor")

  const preview = document.createElement("div")
  preview.className = "prose prose-sm dark:prose-invert max-w-none wrap-break-word p-3 rounded-lg border border-border bg-bg-input/30 min-h-[120px]"
  preview.hidden = true

  const parent = textarea.parentElement!
  parent.insertBefore(host, textarea)
  host.append(header, notice)
  textarea.after(visual, preview)

  let currentMode: DescriptionEditorMode = "markdown"
  let syncingVisual = false
  let lossyLocked = false

  async function renderInto(target: HTMLElement, md: string, interactivePreview: boolean): Promise<void> {
    if (!md.trim()) {
      const empty = document.createElement("em")
      empty.className = "text-text-muted"
      empty.textContent = "Nothing to preview."
      target.replaceChildren(empty)
      return
    }
    const [{ renderMarkdownToHtml }, { sanitizeClient }] = await Promise.all([
      import("@lib/markdown-client"),
      import("@lib/sanitize-client"),
    ])
    if (signal.aborted) return
    const cleanHtml = sanitizeClient(renderMarkdownToHtml(md))
    const parsed = new DOMParser().parseFromString(cleanHtml, "text/html")
    if (interactivePreview) afterPreviewRender?.(parsed.body)
    target.replaceChildren(...Array.from(parsed.body.childNodes))
  }

  async function setMode(nextMode: DescriptionEditorMode, focus = true): Promise<void> {
    currentMode = nextMode
    for (const [m, btn] of modeButtons) {
      btn.setAttribute("aria-selected", String(m === nextMode))
      btn.classList.toggle("active", m === nextMode)
    }
    toolbar.hidden = nextMode === "preview"
    field.hidden = nextMode !== "markdown"
    visual.hidden = nextMode !== "visual"
    preview.hidden = nextMode !== "preview"
    notice.hidden = true

    if (nextMode === "visual") {
      lossyLocked = hasLossyStructure(field.value)
      visual.contentEditable = lossyLocked ? "false" : "true"
      if (lossyLocked) {
        notice.textContent = "This description uses tables, fenced code, or HTML that edits safely in Markdown mode."
        notice.hidden = false
      }
      await renderInto(visual, field.value, false)
      if (!lossyLocked && focus && !signal.aborted) visual.focus()
    } else if (nextMode === "preview") {
      await renderInto(preview, field.value, true)
    } else if (focus) {
      field.focus()
    }
  }

  for (const [m, btn] of modeButtons) {
    btn.addEventListener("click", () => void setMode(m), { signal })
  }

  visual.addEventListener("input", () => {
    if (syncingVisual || lossyLocked) return
    syncingVisual = true
    textarea.value = domToMarkdown(visual)
    textarea.dispatchEvent(new Event("input", { bubbles: true }))
    syncingVisual = false
  }, { signal })

  // Paste firewall: sanitize pasted HTML to safe Markdown without inline styles/scripts
  const handlePaste = async (e: ClipboardEvent, targetIsVisual: boolean) => {
    const html = e.clipboardData?.getData("text/html")
    if (!html || !/<(b|strong|i|em|u|ul|ol|li|h[1-6]|pre|code|blockquote|a|table)\b/i.test(html)) return
    e.preventDefault()
    const [{ sanitizeClient }] = await Promise.all([import("@lib/sanitize-client")])
    if (signal.aborted) return
    const clean = sanitizeClient(html)
    const doc = new DOMParser().parseFromString(clean, "text/html")
    const md = domToMarkdown(doc.body) || e.clipboardData?.getData("text/plain") || ""
    if (targetIsVisual && !lossyLocked) {
      const sel = window.getSelection()
      if (sel && sel.rangeCount > 0) {
        const range = sel.getRangeAt(0)
        range.deleteContents()
        const frag = document.createDocumentFragment()
        frag.append(...Array.from(doc.body.childNodes))
        range.insertNode(frag)
        sel.collapseToEnd()
        visual.dispatchEvent(new Event("input", { bubbles: true }))
      }
    } else {
      const start = textarea.selectionStart ?? textarea.value.length
      const end = textarea.selectionEnd ?? textarea.value.length
      textarea.setRangeText(md, start, end, "end")
      textarea.dispatchEvent(new Event("input", { bubbles: true }))
    }
  }

  textarea.addEventListener("paste", e => void handlePaste(e, false), { signal })
  visual.addEventListener("paste", e => void handlePaste(e, true), { signal })

  signal.addEventListener("abort", () => {
    host.remove()
    visual.remove()
    preview.remove()
    delete textarea.dataset.mdEnhanced
  }, { once: true })

  return {
    syncFromTextarea: () => {
      if (currentMode === "visual") void renderInto(visual, textarea.value, false)
      else if (currentMode === "preview") void renderInto(preview, textarea.value, true)
    },
    setMode,
  }
}
