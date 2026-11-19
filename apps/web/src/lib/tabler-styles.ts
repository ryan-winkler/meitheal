import tablerStylesHref from "../styles/tabler-surface.scss?url"

let loadingStyles: Promise<void> | undefined

export function ensureTablerStyles(): Promise<void> {
  if (loadingStyles) return loadingStyles
  const existing = document.querySelector<HTMLLinkElement>("#meitheal-tabler-styles")
  if (existing?.sheet) return Promise.resolve()
  const link = existing ?? document.createElement("link")
  loadingStyles = new Promise((resolve, reject) => {
    link.addEventListener("load", () => resolve(), { once: true })
    link.addEventListener("error", () => {
      link.remove()
      reject(new Error("Tabler styles could not load"))
    }, { once: true })
    if (!existing) {
      link.id = "meitheal-tabler-styles"
      link.rel = "stylesheet"
      link.href = tablerStylesHref
      document.head.append(link)
    }
  }).finally(() => { loadingStyles = undefined })
  return loadingStyles
}
