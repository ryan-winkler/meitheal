/** Shared typed DOM micro-helpers to avoid repeated boilerplate across client controllers. */

export const byId = <T extends HTMLElement = HTMLElement>(id: string): T | null =>
  document.getElementById(id) as T | null

export function domEl<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

export const qs = <T extends Element = HTMLElement>(
  root: ParentNode | null | undefined,
  selector: string,
): T | null => (root ? root.querySelector<T>(selector) : null)

export const setAttr = (
  el: Element | null | undefined,
  name: string,
  value: string,
): void => {
  el?.setAttribute(name, value)
}
