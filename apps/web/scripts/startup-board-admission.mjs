/** Private process-local capabilities. No serialized value or environment flag is admission. */
const admissions = new WeakMap()
const operatorAdmissions = new WeakSet()

export function registerStartupBoardAdmission(tx) {
  const admission = Object.freeze({})
  admissions.set(admission, tx)
  return admission
}

export function consumeStartupBoardAdmission(admission, tx) {
  if (!admission || admissions.get(admission) !== tx) return false
  admissions.delete(admission)
  return true
}

/** Only the cold operator helper calls this after durable external custody consumption. */
export function registerConsumedOperatorAdmission() {
  const admission = Object.freeze({})
  operatorAdmissions.add(admission)
  return admission
}

export function consumeOperatorAdmission(admission) {
  if (!admission || !operatorAdmissions.has(admission)) return false
  operatorAdmissions.delete(admission)
  return true
}
