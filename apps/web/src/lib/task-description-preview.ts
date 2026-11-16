import { parseFragment, type DefaultTreeAdapterTypes } from "parse5"

const blockTags = new Set(["br", "div", "li", "p", "pre", "h1", "h2", "h3", "h4", "h5", "h6"])
const hiddenTags = new Set(["script", "style", "template"])

export function taskDescriptionPreview(description: unknown): string {
  const input = typeof description === "string" ? description.slice(0, 4096) : ""
  if (!/[<&]/.test(input)) return input.trim().slice(0, 320)

  const text: string[] = []
  function collect(node: DefaultTreeAdapterTypes.ChildNode): void {
    if ("value" in node) {
      text.push(node.value)
    } else if ("tagName" in node && !hiddenTags.has(node.tagName)) {
      if (blockTags.has(node.tagName)) text.push(" ")
      node.childNodes.forEach(collect)
      if (blockTags.has(node.tagName)) text.push(" ")
    }
  }
  parseFragment(input).childNodes.forEach(collect)
  return text.join("").replace(/\s+/g, " ").trim().slice(0, 320)
}
