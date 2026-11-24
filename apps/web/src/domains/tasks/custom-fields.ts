import type { Client } from "@libsql/client"
import type { BoardScope } from "./board-scope"
import { SettingsRepository } from "./persistence/settings-repository"
import {
  boardCustomFieldsSettingKey,
  normalizeCustomFieldDefs,
  type CustomFieldDef,
} from "../../lib/custom-field-defs"

export async function readBoardCustomFieldDefs(
  client: Pick<Client, "execute" | "batch">,
  scope: Pick<BoardScope, "boardId">,
): Promise<CustomFieldDef[]> {
  const repo = new SettingsRepository(client)
  await repo.ensureSettingsTable()
  const key = boardCustomFieldsSettingKey(scope.boardId)
  const values = await repo.getByKeys([key])
  return normalizeCustomFieldDefs(values[key])
}

export async function writeBoardCustomFieldDefs(
  client: Pick<Client, "execute" | "batch">,
  scope: Pick<BoardScope, "boardId">,
  fields: CustomFieldDef[],
): Promise<CustomFieldDef[]> {
  const normalized = normalizeCustomFieldDefs(fields)
  const repo = new SettingsRepository(client)
  await repo.ensureSettingsTable()
  await repo.upsert(boardCustomFieldsSettingKey(scope.boardId), JSON.stringify(normalized))
  return normalized
}
