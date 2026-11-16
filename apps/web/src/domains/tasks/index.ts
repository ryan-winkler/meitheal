/** Public task persistence and board-availability operations used across contexts. */
export { AreaRepository } from "./persistence/area-repository"
export {
  commitSyncMutationChunks,
  ensureDatabaseSchemaSupported,
  ensureSchema,
  findTasksByExternalSyncIds,
  getLocalDataDirectory,
  getPersistenceClient,
  resetPersistenceForTests,
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
  decodeOriginHeader,
  sanitizeOriginKind,
  sanitizeOriginName,
  sanitizeOriginTarget,
  isSettingsOriginTarget,
  taskAddedActivity,
  taskChangedActivity,
  VERIFIED_ORIGIN_KINDS,
  type RecentTaskAction,
  type RecentTaskActor,
  type VerifiedActivityProvenance,
  type VerifiedOriginKind,
} from "./persistence/recent-activity"
export {
  AI_HANDOFF_SETTING_KEYS,
  getSettingsRevision,
  saveAiHandoffSettings,
  saveLegacyAiHandoffUrl,
  SettingsRepository,
} from "./persistence/settings-repository"
export { rewriteLabelReferences } from "./persistence/label-reference-repository"
export { TaskHandoff } from "./persistence/task-handoff"
export {
  taskInsertStatement,
  TaskRepository,
  type ReassignmentReplayState,
  type TaskCatalogRow,
} from "./persistence/task-repository"
export { customUserKind, UserRepository, type CustomUserKind } from "./persistence/user-repository"
export {
  dispatchTaskCreation,
  prepareTaskCreation,
  taskCreationPayload,
  taskLabelsJson,
} from "./task-creation-service"
export { startInactivityScheduler } from "./task-inactivity-scheduler"
export {
  boardDraftHeader,
  hasBoardSelection,
  isBoardTaskApiPath,
  rejectBoardSelectionInJson,
  rejectBoardSelectionInUrl,
  unavailableBoardResponse,
} from "./board-availability"
