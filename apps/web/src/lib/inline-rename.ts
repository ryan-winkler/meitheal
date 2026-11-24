export interface InlineRenameOptions {
  labelEl: HTMLElement
  value: string
  placeholder: string
  maxLength: number
  className: string
  signal?: AbortSignal
  stopClick?: boolean
  hideLabel?: boolean
  onCommit: (nextValue: string) => void
  onCancel?: () => void
  onCleanup?: () => void
}

/** Mounts a shared keyboard-accessible inline rename input over a label element. */
export function mountInlineRename(opts: InlineRenameOptions): void {
  const { labelEl, value, placeholder, maxLength, className, signal, stopClick, hideLabel, onCommit, onCancel, onCleanup } = opts
  const input = document.createElement("input")
  input.type = "text"
  input.className = className
  input.value = value
  input.placeholder = placeholder
  input.maxLength = maxLength
  input.setAttribute("aria-label", `Rename ${placeholder}`)

  let settled = false
  const finish = (save: boolean) => {
    if (settled) return
    settled = true
    const raw = input.value
    if (hideLabel) {
      input.remove()
      labelEl.hidden = false
    }
    onCleanup?.()
    if (save) onCommit(raw)
    else onCancel?.()
  }

  const listenerOpts = signal ? { signal } : undefined
  input.addEventListener("keydown", ev => {
    if (stopClick) ev.stopPropagation()
    if (ev.key === "Enter") { ev.preventDefault(); finish(true) }
    else if (ev.key === "Escape") { ev.preventDefault(); finish(false) }
  }, listenerOpts)
  input.addEventListener("blur", () => finish(true), listenerOpts)
  if (stopClick) input.addEventListener("click", ev => ev.stopPropagation(), listenerOpts)

  if (hideLabel) {
    labelEl.hidden = true
    labelEl.after(input)
  } else {
    labelEl.replaceChildren(input)
  }
  input.focus()
  input.select()
}
