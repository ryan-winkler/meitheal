/** Public task persistence operations used by other in-app contexts. */
export {
  commitSyncMutationChunks,
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
export { rewriteLabelReferences } from "./persistence/label-reference-repository"
export { TaskHandoff } from "./persistence/task-handoff"
