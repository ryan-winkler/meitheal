/** Public task persistence and board-availability operations used across contexts. */
export { AreaRepository } from "./persistence/area-repository"
export {
  commitSyncMutationChunks,
  ensureDatabaseSchemaSupported,
  ensureSchema,
  findTasksByExternalSyncIds,
  getLocalDataDirectory,
  getPersistenceClient,
  type ExternalSyncLookup,
  type ExternalSyncMatch,
  type SyncChunkCommitResult,
  type SyncChunkItemError,
  type SyncConfirmationTarget,
  type SyncTaskMutation,
} from "./persistence/store"
export { HierarchyRepository } from "./persistence/hierarchy-repository"
export {
  discardUnappliedTaskActivity,
  readRecentActivity,
  recentActivityPersonKey,
  sanitizeOriginKind,
  sanitizeOriginName,
  sanitizeOriginTarget,
  taskAddedActivity,
  taskChangedActivity,
  VERIFIED_ORIGIN_KINDS,
  type RecentTaskAction,
  type RecentTaskActor,
  type VerifiedActivityProvenance,
  type VerifiedOriginKind,
} from "./persistence/recent-activity"
export { getSettingsRevision, SettingsRepository } from "./persistence/settings-repository"
export { rewriteLabelReferences } from "./persistence/label-reference-repository"
export { TaskHandoff } from "./persistence/task-handoff"
export { TaskRepository, type ReassignmentReplayState, type TaskCatalogRow } from "./persistence/task-repository"
export { customUserKind, UserRepository, type CustomUserKind } from "./persistence/user-repository"
export { startInactivityScheduler } from "./task-inactivity-scheduler"
export {
  boardDraftHeader,
  hasBoardSelection,
  isBoardTaskApiPath,
  rejectBoardSelectionInJson,
  rejectBoardSelectionInUrl,
  unavailableBoardResponse,
} from "./board-availability"
