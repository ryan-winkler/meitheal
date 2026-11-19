import type { VerifiedPrincipal } from "./board-scope"
import { sql, type SqlFragment } from "./persistence/sql-fragment"

/** Current one-principal feature audience. This predicate grants no resource CRUD authority. */
export function featureAudienceAllowed(principal: VerifiedPrincipal, feature: string): SqlFragment {
  const legacyKeys: Record<string, string> = { routines: "habits", achievements: "gamification" }
  const fallback = feature === "home_assistant_area" ? sql`0` : sql`NOT EXISTS (
    SELECT 1 FROM settings WHERE key = ${`feature_${legacyKeys[feature] ?? feature}`} AND value IN ('false','"false"'))`
  return sql`CASE WHEN EXISTS (SELECT 1 FROM organization_access_policies
      WHERE scope = 'feature' AND scope_id = ${feature} AND board_id = '')
    THEN NOT EXISTS (SELECT 1 FROM organization_access_policies AS feature_policy
      WHERE feature_policy.scope = 'feature' AND feature_policy.scope_id = ${feature} AND feature_policy.board_id = ''
        AND NOT (feature_policy.audience = 'everyone' OR (${principal.kind === "ha_user" ? 1 : 0} = 1 AND feature_policy.audience = 'selected'
          AND EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(feature_policy.selected_users) THEN CASE WHEN json_type(feature_policy.selected_users) = 'array' THEN feature_policy.selected_users ELSE '[]' END ELSE '[]' END) AS feature_user
            WHERE feature_user.type = 'text' AND feature_user.value = ${principal.id}))))
    ELSE ${fallback} END`
}
