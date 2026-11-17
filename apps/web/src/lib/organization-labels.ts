import { createHmac, randomBytes, timingSafeEqual } from "node:crypto"
import type { APIContext } from "astro"
import { ensureSchema, getPersistenceClient } from "@domains/tasks"
import { getFeatureFlags, type FeatureFlags } from "./feature-flags"
import { COOKIE_NAME, isValidLocale, type Locale } from "./locale"
import { verifiedIngressUser } from "./verified-ingress-user"

const terms = {
  board: { en: ["Board", "Boards"], ga: ["Clár", "Cláir"] },
  group: { en: ["Group", "Groups"], ga: ["Grúpa", "Grúpaí"] },
  project: { en: ["Project", "Projects"], ga: ["Tionscadal", "Tionscadail"] },
  task: { en: ["Task", "Tasks"], ga: ["Tasc", "Tascanna"] },
  goal: { en: ["Goal", "Goals"], ga: ["Sprioc", "Spriocanna"] },
  routine: { en: ["Routine", "Routines"], ga: ["Gnáthamh", "Gnáthaimh"] },
  pillar: { en: ["Pillar", "Pillars"], ga: ["Colún", "Colúin"] },
  principle: { en: ["Principle", "Principles"], ga: ["Prionsabal", "Prionsabail"] },
  achievement: { en: ["Achievement", "Achievements"], ga: ["Éacht", "Éachtaí"] },
  planning: { en: ["Planning"], ga: ["Pleanáil"] },
  progress: { en: ["Progress & Growth"], ga: ["Dul Chun Cinn & Fás"] },
} as const

export type OrganizationTerm = keyof typeof terms
export type OrganizationForms = [string, string?]
export type OrganizationAliases = Partial<Record<OrganizationTerm, OrganizationForms>>
type OrganizationLabelContext = Pick<APIContext, "locals" | "cookies">
const termNames = Object.keys(terms) as OrganizationTerm[]
const formSecret = randomBytes(32)
const requestLabels = new WeakMap<App.Locals, Promise<OrganizationLabelState | null>>()

export function defaultOrganizationLabel(term: OrganizationTerm, locale: Locale, plural = false): string {
  return terms[term][locale][plural ? 1 : 0] ?? terms[term][locale][0]
}

export function visibleOrganizationTerms(flags: FeatureFlags): OrganizationTerm[] {
  return termNames.filter((term) => {
    switch (term) {
      case "board": return true
      case "group": return flags.groups !== false
      case "project": return flags.projects !== false
      case "goal": return flags.goals !== false
      case "pillar": return flags.pillars !== false
      case "principle": return flags.pillars !== false && flags.principles !== false
      case "planning": return flags.planning !== false
      case "routine": return flags.habits !== false
      case "achievement": return flags.gamification !== false
      default: return true
    }
  })
}

export function hasPluralOrganizationLabel(term: OrganizationTerm): boolean {
  return terms[term].en.length > 1
}

export function organizationLocale(context: OrganizationLabelContext): Locale {
  const locale = context.cookies.get(COOKIE_NAME)?.value
  return isValidLocale(locale) ? locale : "en"
}

export function labelsProof(userId: string, locale: Locale): string {
  return createHmac("sha256", formSecret).update(JSON.stringify([userId, locale])).digest("base64url")
}

export function renderedLabelsProof(userId: string, locale: Locale, state: OrganizationLabelState, settings: boolean) {
  return createHmac("sha256", formSecret)
    .update(JSON.stringify(["rendered-labels", userId, locale, ...(settings ? [] : [state.revision, state.visible])]))
    .digest("base64url")
}

export function matchesLabelsProof(proof: unknown, userId: string, locale: Locale): boolean {
  if (typeof proof !== "string" || !/^[a-zA-Z0-9_-]{43}$/.test(proof)) return false
  return timingSafeEqual(Buffer.from(proof), Buffer.from(labelsProof(userId, locale)))
}

export function parseOrganizationAliases(value: unknown, allowed = termNames): OrganizationAliases | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const aliases: OrganizationAliases = {}
  for (const [key, forms] of Object.entries(value)) {
    const term = key as OrganizationTerm
    if (!allowed.includes(term) || !Array.isArray(forms) ||
      forms.length !== terms[term].en.length || forms.some((form) => typeof form !== "string")) return null
    const cleaned = forms.map((form: string) => form.trim())
    if (cleaned.some((form) => Array.from(form).length > 40 || /[\p{Cc}\p{Bidi_Control}]/u.test(form))) return null
    if (cleaned.some(Boolean)) aliases[term] = cleaned as OrganizationForms
  }
  return aliases
}

export interface OrganizationLabelState {
  forms: OrganizationAliases
  revision: string
  visible: OrganizationTerm[]
}

export async function readOrganizationLabelState(userId: string, locale: Locale): Promise<OrganizationLabelState> {
  await ensureSchema()
  const [result, flags] = await Promise.all([
    getPersistenceClient().execute({
      sql: "SELECT forms, revision FROM organization_label_preferences WHERE user_id = ? AND locale = ?",
      args: [userId, locale],
    }),
    getFeatureFlags(),
  ])
  const row = result.rows[0]
  const forms = row ? parseOrganizationAliases(JSON.parse(String(row.forms))) : {}
  if (!forms) throw new Error("Invalid stored organization labels")
  return { forms, revision: String(row?.revision ?? ""), visible: visibleOrganizationTerms(flags) }
}

export async function saveOrganizationLabelState(
  userId: string, locale: Locale, previous: OrganizationLabelState, forms: OrganizationAliases,
): Promise<boolean> {
  const next = { ...previous.forms }
  for (const term of previous.visible) delete next[term]
  Object.assign(next, forms)
  const revision = randomBytes(16).toString("hex")
  const client = getPersistenceClient()
  const result = previous.revision
    ? await client.execute({
      sql: "UPDATE organization_label_preferences SET forms = ?, revision = ? WHERE user_id = ? AND locale = ? AND revision = ?",
      args: [JSON.stringify(next), revision, userId, locale, previous.revision],
    })
    : await client.execute({
      sql: "INSERT INTO organization_label_preferences (user_id, locale, forms, revision) VALUES (?, ?, ?, ?) ON CONFLICT (user_id, locale) DO NOTHING",
      args: [userId, locale, JSON.stringify(next), revision],
    })
  return result.rowsAffected === 1
}

export function readRequestOrganizationLabels(context: OrganizationLabelContext): Promise<OrganizationLabelState | null> {
  const user = verifiedIngressUser(context.locals)
  if (!user) return Promise.resolve(null)
  let pending = requestLabels.get(context.locals)
  if (!pending) {
    pending = readOrganizationLabelState(user.id, organizationLocale(context)).catch(() => null)
    requestLabels.set(context.locals, pending)
  }
  return pending
}

export function organizationLabelResolver(
  state: OrganizationLabelState | null, locale: Locale,
) {
  return (term: OrganizationTerm, plural = false, fallback?: string): string =>
    (state?.visible.includes(term) ? state.forms[term]?.[plural ? 1 : 0] : undefined) ||
    fallback || defaultOrganizationLabel(term, locale, plural)
}

export function newOrganizationLabel(label: string, locale: Locale): string {
  return locale === "ga" ? `${label} nua` : `New ${label}`
}

export async function organizationLabelsFor(context: OrganizationLabelContext) {
  return organizationLabelResolver(await readRequestOrganizationLabels(context), organizationLocale(context))
}
