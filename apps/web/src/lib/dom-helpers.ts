/**
 * Lightweight typed DOM query and construction helpers.
 *
 * Bounded context: UI Infrastructure
 */

export function byId<T extends HTMLElement = HTMLElement>(
  id: string,
  root: Document | DocumentFragment = document,
): T | null {
  return root.getElementById(id) as T | null
}

export function qs<T extends Element = HTMLElement>(
  root: ParentNode | null | undefined,
  selector: string,
): T | null {
  return root ? root.querySelector<T>(selector) : null
}

export function domEl<K extends keyof HTMLElementTagNameMap>(
  tag: K,
): HTMLElementTagNameMap[K] {
  return document.createElement(tag)
}

export function setAttr(
  el: Element | null | undefined,
  name: string,
  value: string,
): void {
  el?.setAttribute(name, value)
}
