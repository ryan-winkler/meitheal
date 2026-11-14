/** Public task persistence and board-availability operations used across contexts. */
export { AreaRepository } from "./persistence/area-repository"
export {
  commitSyncMutationChunks,
  ensureDatabaseSchemaSupported,
  ensureSchema,
  findTasksByExternalSyncIds,
  getPersistenceClient,
  type ExternalSyncLookup,
  type ExternalSyncMatch,
  type SyncChunkCommitResult,
  type SyncChunkItemError,
  type SyncConfirmationTarget,
  type SyncTaskMutation,
} from "./persistence/store"
export { getSettingsRevision, SettingsRepository } from "./persistence/settings-repository"
export { rewriteLabelReferences } from "./persistence/label-reference-repository"
export { TaskHandoff } from "./persistence/task-handoff"
export { TaskRepository, type TaskCatalogRow } from "./persistence/task-repository"
export { startInactivityScheduler } from "./task-inactivity-scheduler"
export {
  boardDraftHeader,
  hasBoardSelection,
  isBoardTaskApiPath,
  rejectBoardSelectionInJson,
  rejectBoardSelectionInUrl,
  unavailableBoardResponse,
} from "./board-availability"
