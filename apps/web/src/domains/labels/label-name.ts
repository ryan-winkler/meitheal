/** Shared identity for persisted names, reference edits and presentation lookup. */
export function labelNameKey(name: string) {
  return name.trim().normalize("NFC").toLowerCase().normalize("NFC")
}

/** JSON may contain lone UTF-16 surrogates that SQLite text bindings cannot retain. */
export function isWellFormedLabelName(name: string) {
  return /^(?:[\u0000-\uD7FF\uE000-\uFFFF]|[\uD800-\uDBFF][\uDC00-\uDFFF])*$/.test(name)
}
