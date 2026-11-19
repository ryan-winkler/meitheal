/** Public task persistence and board-availability operations used across contexts. */
export { BoardAccessService, validateBoardFeature, validateBoardPlacement } from "./board-access-service"
export { createBoardAgentCredential } from "./agent-board-authority"
export { resolveHAAssignmentProof, type AssignmentProof } from "./assignment-proof"
export { listSharedGoals } from "./persistence/shared-goal-repository"
export { TemplateRepository } from "./persistence/template-repository"
export {
  isVerifiedPrincipalCurrent, boardPlanningOwnership, boardTaskOwnership, boardOwnerInsertExpression,
  guardWorkPersistence, sql, sourceSql, joinSql, type SqlFragment,
} from "./server-persistence"
export {
  requireBoardScope, scopeAssignedTo, scopePermits, scopeServicePurpose, scopeBoardAccess, validateBoardScope,
  type BoardScope, type BoardCapabilities, type ScopeResult, type VerifiedPrincipal,
  type WorkOperation, type WorkResource, type WorkAction, type WorkspaceContext, type TaskPlacement,
} from "./board-scope"
export { BoardRepository } from "./persistence/named-board-repository"
export { NamedBoardTaskRepository } from "./persistence/named-board-task-repository"
export { IdentityRepository } from "./persistence/identity-repository"
export { readTaskDeletionReceipt, type TaskDeletionReceipt } from "./persistence/task-deletion-receipt"
export {
  resolveIntegrationScope, validateIntegrationScope, integrationOperationAllowed, resolveIntegrationRecipient,
  type IntegrationScope, type IntegrationScopeResult,
} from "./board-automation"
export {
  readWorkDestinations, parseWorkDestinations, selectWorkBinding, bindingAllows,
  type WorkBinding, type WorkDestinations, type WorkDestination,
} from "./integration-destinations"
export { projectPublicTaskFields, TASK_PUBLIC_FIELDS } from "./task-projection"
export { boardOperationClient, BoardOperationError, canReadBoardAggregate, validateTaskOperation } from "./persistence/board-operation-client"
export { AreaRepository } from "./persistence/area-repository"
export {
  commitSyncMutationChunks,
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
export { rewriteLabelReferences, findUsedLabelDefinitions, removeBoardLabelJunctions } from "./persistence/label-reference-repository"
export { TaskHandoff } from "./persistence/task-handoff"
export {
  taskInsertStatement,
  TaskRepository,
  type CalendarFilterRow,
  type KanbanIndexRow,
  type KanbanLane,
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
export { resolveTaskEpics, type TaskEpicLink } from "./task-epic-groups"
export {
  boardDraftHeader,
  hasBoardSelection,
  isBoardTaskApiPath,
  rejectBoardSelectionInJson,
  rejectBoardSelectionInUrl,
  unavailableBoardResponse,
} from "./board-availability"


export { isWorkIntegrationSetting, saveWorkIntegrationSettings, saveWorkBinding } from "./work-binding-manager"
export { currentBoardGrantRevision } from "./persistence/board-grant-fence"
export { persistManualCalendarConfirmation } from "./persistence/store"

export { readTaskAssignmentReceipt, type TaskAssignmentReceipt } from "./persistence/task-assignment-receipt"
export { checkOverdueTaskEvents } from "./overdue-task-events"
export { prepareWorkIntegrationSettings, validateWorkIntegrationSettingsApproval, sameWorkIntegrationSetting,
  type WorkIntegrationSettingsApproval } from "./work-binding-manager"
