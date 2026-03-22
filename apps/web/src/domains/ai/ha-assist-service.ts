/**
 * HA Assist Service — Client-Side
 *
 * Bounded context for HA-native AI interaction.
 * Handles task context generation for Assist calls
 * and preferred agent management.
 *
 * @domain ai
 * @bounded-context ha-assist
 */

import { getTask, type OfflineTask } from "../offline/offline-store";

const AGENT_KEY = "meitheal:assist-agent";

/**
 * Build a task-aware context string for injection into Assist calls.
 * Returns null if the task is not found.
 */
export async function buildTaskContext(taskId: string): Promise<string | null> {
  let task: OfflineTask | undefined;

  try {
    task = await getTask(taskId);
  } catch {
    // Not in offline store
  }

  if (!task) {
    try {
      const res = await fetch(`${window.__ingress_path || ""}/api/v1/tasks/${taskId}`);
      if (res.ok) {
        const data = await res.json();
        if (data) {
          task = {
            id: data.id ?? taskId,
            title: data.title ?? "Untitled",
            description: data.description ?? "",
            status: data.status ?? "pending",
            priority: data.priority ?? 3,
            dueDate: data.due_date ?? null,
            areaId: data.area_id ?? null,
            labels: data.labels ?? null,
            kind: data.kind ?? "standard_action",
            sortOrder: data.sort_order ?? 0,
            createdAt: data.created_at ?? new Date().toISOString(),
            updatedAt: data.updated_at ?? new Date().toISOString(),
            syncedAt: new Date().toISOString(),
          };
        }
      }
    } catch {
      // Silently fail
    }
  }

  if (!task) return null;

  return `[Meitheal Task Context] Title: "${task.title}" | Status: ${task.status} | Due: ${task.dueDate ?? "none"} | Description: ${task.description || "none"}`;
}

/**
 * Get the user's preferred conversation agent ID.
 * Returns empty string for default agent.
 */
export function getPreferredAgent(): string {
  if (typeof sessionStorage === "undefined") return "";
  return sessionStorage.getItem(AGENT_KEY) || "";
}

/**
 * Set the user's preferred conversation agent ID.
 */
export function setPreferredAgent(agentId: string): void {
  if (typeof sessionStorage === "undefined") return;
  sessionStorage.setItem(AGENT_KEY, agentId);
}
