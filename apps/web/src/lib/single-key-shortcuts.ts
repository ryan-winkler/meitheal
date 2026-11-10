export const SINGLE_KEY_SHORTCUTS_STORAGE_KEY = "meitheal-single-key-shortcuts"

export function singleKeyShortcutsEnabled(): boolean {
  try {
    return localStorage.getItem(SINGLE_KEY_SHORTCUTS_STORAGE_KEY) !== "off"
  } catch {
    return true
  }
}

export function setSingleKeyShortcuts(enabled: boolean): void {
  localStorage.setItem(SINGLE_KEY_SHORTCUTS_STORAGE_KEY, enabled ? "on" : "off")
}

/** Use in mixed handlers that also provide arrow keys or native activation. */
export function isDisabledCharacterShortcut(key: string): boolean {
  return key.length === 1 && key !== " " && !singleKeyShortcutsEnabled()
}
