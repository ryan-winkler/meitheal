/**
 * Eisenhower Triage Bridge
 *
 * Delegates to the unified Tabler Multi-Framework Scoring Triage modal
 * while preserving pure helper exports used by eisenhower-review.ts.
 *
 * @domain tasks
 * @bounded-context tasks (presentation)
 */

import { readTaskFrameworkPayload, taskApi } from "@lib/task-api-client"

/** Derive quadrant label from urgency × importance values */
export function quadrantPreview(urgency: number, importance: number): string {
  if (urgency === 0 && importance === 0) return "Set values to classify"
  const urgent = urgency >= 3
  const important = importance >= 3
  if (urgent && important) return "Do First (Urgent & Important)"
  if (!urgent && important) return "Schedule (Important, Not Urgent)"
  if (urgent && !important) return "Delegate (Urgent, Not Important)"
  return "Not Now (Low Urgency & Importance)"
}

/** Open the unified Tabler Scoring Triage modal pre-selected to Eisenhower */
export async function startTriage(onComplete: () => void): Promise<void> {
  const { openScoringTriage } = await import("@lib/controllers/scoring-triage-controller")
  await openScoringTriage({
    framework: "eisenhower",
    onComplete,
  })
}

export function closeTriage(): void {
  void import("@lib/controllers/scoring-triage-controller").then(({ closeScoringTriage }) => {
    closeScoringTriage(false)
  })
}

export function triageNext(): void {
  // Handled internally by scoring-triage-controller
}

export async function triageSave(): Promise<void> {
  // Handled internally by scoring-triage-controller
}

export function setupTriageListeners(_signal: AbortSignal): void {
  // Listeners are attached lazily when ScoringTriageModal opens
}

/** Read known framework values before replacing their serialized payload. */
export async function getExistingFrameworkPayload(taskId: string): Promise<Record<string, unknown>> {
  return readTaskFrameworkPayload(await taskApi.getTask(taskId), taskId)
}
