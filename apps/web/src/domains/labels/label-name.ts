/** Shared identity for persisted names, reference edits and presentation lookup. */
export function labelNameKey(name: string) {
  return name.trim().normalize("NFC").toLowerCase().normalize("NFC")
}

/** JSON may contain lone UTF-16 surrogates that SQLite text bindings cannot retain. */
export function isWellFormedLabelName(name: string) {
  return !/[\uD800-\uDFFF]/u.test(name)
}
