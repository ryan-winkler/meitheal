import type { VerifiedPrincipal } from "./board-scope"
import { sourceSql, sql, type SqlFragment } from "./persistence/sql-fragment"

/** A policy row admits a principal only through an open or explicit HA audience. */
export function organizationAudienceAllowed(principal: VerifiedPrincipal, table: "feature_policy" | "board_policy"): SqlFragment {
  const audience = sourceSql(`${table}.audience`)
  const selected = sourceSql(`${table}.selected_users`)
  return sql`COALESCE((${audience} = 'everyone' OR (${principal.kind === "ha_user" ? 1 : 0} = 1 AND ${audience} = 'selected'
    AND EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(${selected}) THEN
      CASE WHEN json_type(${selected}) = 'array' THEN ${selected} ELSE '[]' END ELSE '[]' END) AS audience_user
      WHERE audience_user.type = 'text' AND audience_user.value = ${principal.id}))), 0)`
}

/** Current one-principal feature audience. This predicate grants no resource CRUD authority. */
export function featureAudienceAllowed(principal: VerifiedPrincipal, feature: string): SqlFragment {
  const legacyKeys: Record<string, string> = { routines: "habits", achievements: "gamification" }
  const fallback = feature === "home_assistant_area" ? sql`0` : sql`NOT EXISTS (
    SELECT 1 FROM settings WHERE key = ${`feature_${legacyKeys[feature] ?? feature}`} AND value IN ('false','"false"'))`
  return sql`CASE WHEN EXISTS (SELECT 1 FROM organization_access_policies
      WHERE scope = 'feature' AND scope_id = ${feature} AND board_id = '')
    THEN NOT EXISTS (SELECT 1 FROM organization_access_policies AS feature_policy
      WHERE feature_policy.scope = 'feature' AND feature_policy.scope_id = ${feature} AND feature_policy.board_id = ''
        AND NOT ${organizationAudienceAllowed(principal, "feature_policy")})
    ELSE ${fallback} END`
}
