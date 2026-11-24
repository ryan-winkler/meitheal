export const HIDE_ASK_AI_KEY = "meitheal:hide-ask-ai:v1"

export function readHideAskAi(): boolean {
  try {
    return localStorage.getItem(HIDE_ASK_AI_KEY) === "1"
  } catch {
    return false
  }
}

export function applyHideAskAi(hidden: boolean): void {
  if (typeof document === "undefined") return
  document.documentElement.toggleAttribute("data-hide-ask-ai", hidden)
}

export function saveHideAskAi(hidden: boolean): void {
  try {
    if (hidden) localStorage.setItem(HIDE_ASK_AI_KEY, "1")
    else localStorage.removeItem(HIDE_ASK_AI_KEY)
  } catch {
    /* ignore private browsing */
  }
  applyHideAskAi(hidden)
}
