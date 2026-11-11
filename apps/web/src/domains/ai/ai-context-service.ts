/**
 * AI Context Service
 *
 * Sends task-context prompts to HA Assist (conversation.process) for inline
 * AI responses. Falls back to clipboard + external provider when HA is
 * disconnected.
 *
 * Bounded Context: ai / tasks
 * @domain ai
 */

import { getTask, type OfflineTask } from "../offline/offline-store";
import { createClientLogger } from "@lib/client-logger";
import { showToast } from "@lib/toast"
import { parseAiHandoffUrl } from "@lib/ai-handoff-url"
import { confirmDialog } from "@lib/confirm-dialog"
import { getClientLocale, t } from "../../i18n/client"

const log = createClientLogger("ai", "context");

/** Extended task interface with optional fields from persistence layer */
interface TaskWithExtras extends OfflineTask {
  taskType?: string;
  task_type?: string;
}

/** Result from a task AI request. */
export type AIResult =
  | { source: "ha-assist"; response: string; conversationId?: string | undefined }
  | { source: "none" }

/**
 * Get the configured HA conversation agent ID from settings.
 * Falls back to undefined (HA's default agent).
 */
async function getAgentId(signal?: AbortSignal): Promise<string | undefined> {
  try {
    const res = await fetch("/api/settings?key=ha-assist-agent", { signal: signal ?? null })
    if (!res.ok) return undefined
    const data = await res.json()
    // Empty is an intentional selection of built-in Assist, not a missing key.
    if (data?.value !== null && data?.value !== undefined) {
      return typeof data.value === "string" && data.value ? data.value : undefined
    }
    const legacy = await fetch("/api/settings?key=ha-agent-id", { signal: signal ?? null })
    if (legacy.ok) {
      const old = await legacy.json()
      if (typeof old?.value === "string" && old.value) return old.value
    }
  } catch { /* use HA's default */ }
  return undefined
}

/**
 * Fetch full task data from offline store or API.
 */
async function resolveTask(taskId: string, signal?: AbortSignal): Promise<TaskWithExtras> {
  let raw = await getTask(taskId);
  signal?.throwIfAborted()

  if (!raw) {
    try {
      const res = await fetch(`/api/tasks/${taskId}`, { signal: signal ?? null })
      if (res.ok) {
        const data = await res.json();
        // Handle both { task: {...} } and flat {...} response shapes
        const t = data?.task ?? data;
        if (t) {
          raw = {
            id: t.id ?? taskId,
            title: t.title ?? "Untitled",
            description: t.description ?? "",
            status: t.status ?? "pending",
            dueDate: t.due_date ?? null,
            labels: t.labels ?? "",
            createdAt: t.created_at ?? new Date().toISOString(),
            updatedAt: t.updated_at ?? new Date().toISOString(),
            syncedAt: new Date().toISOString(),
            synced: true,
            taskType: t.task_type,
            priority: t.priority,
          } as unknown as TaskWithExtras;
        }
      }
    } catch (err) {
      signal?.throwIfAborted()
      log.warn("Failed to fetch task from server", err);
    }
  }

  if (!raw) throw new Error(`Task ${taskId} not found.`);
  return raw as TaskWithExtras;
}

/**
 * Send a prompt to HA Assist and return the response.
 * Returns null if HA is not connected (503).
 */
async function callAssist(
  prompt: string,
  signal?: AbortSignal
): Promise<{ speech: string; conversationId?: string } | null> {
  const agentId = await getAgentId(signal)

  const body: Record<string, string> = { text: prompt };
  if (agentId) body.agent_id = agentId;

  const res = await fetch(
    "/api/ha/assist",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: signal ?? null,
    }
  );

  // HA not connected — signal to fall back
  if (res.status === 503) return null;

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: "Unknown error" }));
    throw new Error(err.error || `Assist returned ${res.status}`);
  }

  const data = await res.json();
  return {
    speech: data.speech ?? "Done.",
    conversationId: data.conversation_id,
  };
}

const builtInHandoffUrls = {
  chatgpt: "https://chatgpt.com/",
  claude: "https://claude.ai/new",
  gemini: "https://gemini.google.com/app",
}
type BuiltInProvider = keyof typeof builtInHandoffUrls
type AiHandoffTarget = { canUseAssist: boolean } & (
  | { provider: "ha_llm" }
  | { provider: BuiltInProvider | "ollama" | "custom"; url: URL | null }
)

/** Resolve the authoritative saved provider before either UI opens a destination. */
export async function resolveAiHandoffTarget(signal?: AbortSignal): Promise<AiHandoffTarget | null> {
  if (signal?.aborted) return null
  try {
    const response = await fetch("/api/settings?key=ai-provider&handoff=1", { signal: signal ?? null, cache: "no-store" })
    if (response.status === 403 || response.status === 409) {
      const problem = await response.json().catch(() => null)
      if (response.status === 403 && problem?.title === "URL review required") {
        if (!signal?.aborted) showToast("settings.ai_handoff_url_review_required", "error")
        return null
      }
      if (response.status === 409 && problem?.title === "Invalid AI URL") {
        if (!signal?.aborted) showToast("settings.ai_handoff_url_invalid", "error")
        return null
      }
    }
    if (!response.ok) throw new Error("Provider settings unavailable")
    const data: unknown = await response.json()
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Invalid provider setting")
    const { key, value, url, canUseAssist, urlProblem } = data as Record<string, unknown>
    if (key !== "ai-provider" || typeof canUseAssist !== "boolean") throw new Error("Invalid handoff settings")
    if (signal?.aborted) return null
    const provider = value === null ? "chatgpt" : value
    if (provider === "ha_llm") return { provider, canUseAssist }
    if (provider === "ollama" || provider === "custom") {
      const target = parseAiHandoffUrl(url)
      if (target) return { provider, url: target, canUseAssist }
      if (canUseAssist && urlProblem === "invalid" && url === undefined) return { provider, url: null, canUseAssist }
      showToast("settings.ai_handoff_url_invalid", "error")
      return null
    }
    if (typeof provider !== "string" || !Object.hasOwn(builtInHandoffUrls, provider)) throw new Error("Invalid provider setting")
    const builtIn = provider as BuiltInProvider
    return { provider: builtIn, url: new URL(builtInHandoffUrls[builtIn]), canUseAssist }
  } catch {
    if (!signal?.aborted) showToast("settings.ai_handoff_provider_unavailable", "error")
    return null
  }
}

/** Keep external navigation on a fresh native link gesture after settings resolve. */
export function offerAiHandoff(url: URL, sendsTaskDetails: boolean, signal?: AbortSignal): Promise<boolean> {
  const locale = getClientLocale()
  return confirmDialog({
    title: t("settings.ai_handoff_open", locale),
    message: t(sendsTaskDetails ? "settings.ai_handoff_review_prompt" : "settings.ai_handoff_review", locale, { host: url.host }),
    confirmText: t("settings.ai_handoff_open", locale),
    confirmUrl: url,
    cancelText: t("common.cancel", locale),
    ...(signal ? { signal } : {}),
  })
}

/** Fall back to clipboard and the saved external provider when Assist is unavailable. */
async function fallbackToClipboard(url: URL, prompt: string, signal?: AbortSignal): Promise<AIResult> {
  const locale = getClientLocale()
  await confirmDialog({
    title: t("settings.ai_handoff_external", locale),
    message: t("settings.ai_handoff_review_copy", locale, { host: url.host }),
    confirmText: t("settings.ai_handoff_open", locale),
    confirmUrl: url,
    copyPrompt: {
      text: prompt,
      label: t("settings.ai_handoff_copy", locale),
      success: t("settings.ai_handoff_copy_success", locale),
      failure: t("settings.ai_handoff_copy_failed", locale),
    },
    cancelText: t("common.cancel", locale),
    ...(signal ? { signal } : {}),
  })
  return { source: "none" }
}

/**
 * Fetch today's calendar events for AI context.
 * Best-effort — returns null if unavailable.
 */
async function fetchCalendarContext(signal?: AbortSignal): Promise<string | null> {
  try {
    // Get configured calendar entities
    const settingsRes = await fetch("/api/settings?key=calendar-entities", { signal: signal ?? null })
    if (!settingsRes.ok) return null;
    const settingsData = await settingsRes.json();
    const entities: string[] = settingsData?.value
      ? (typeof settingsData.value === "string" ? JSON.parse(settingsData.value) : settingsData.value)
      : [];
    if (entities.length === 0) return null;

    const today = new Date();
    const start = today.toISOString().split("T")[0] + "T00:00:00";
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const end = tomorrow.toISOString().split("T")[0] + "T00:00:00";

    const allEvents: Array<{ summary: string; start: string; end: string }> = [];
    for (const entityId of entities.slice(0, 3)) { // Cap at 3 calendars
      const res = await fetch(
        `/api/ha/events?entity_id=${encodeURIComponent(entityId)}&start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`,
        { signal: signal ?? null },
      )
      if (res.ok) {
        const data = await res.json();
        if (data?.events) allEvents.push(...data.events);
      }
    }

    if (allEvents.length === 0) return null;
    return allEvents
      .map((e) => `- ${e.summary} (${e.start} → ${e.end})`)
      .join("\n");
  } catch {
    return null;
  }
}

/**
 * Fetch Pillar context: Non-Negotiable Principles and active Pillar names.
 * Injected into AI prompts so the model respects user values and boundaries.
 * Best-effort — returns null if unavailable.
 *
 * @domain pillars
 * @kcs Non-Negotiables are behavioral boundaries the AI must never contradict
 */
async function fetchPillarContext(signal?: AbortSignal): Promise<string | null> {
  try {
    const res = await fetch("/api/pillars", { signal: signal ?? null })
    if (!res.ok) return null
    const data = await res.json()
    const pillars = data?.pillars ?? []
    if (!Array.isArray(pillars) || pillars.length === 0) return null

    const lines: string[] = []

    // Active Pillar names for identity context
    lines.push("Active Pillars (user's identity anchors):")
    for (const p of pillars) {
      const weight = p.weight ?? 1
      lines.push(`- ${p.icon || "🏛️"} ${p.name} (weight: ${weight}/10)${p.manifesto ? ` — "${p.manifesto}"` : ""}`)
    }

    // Fetch Non-Negotiable Principles for each Pillar
    const nnLines: string[] = []
    for (const p of pillars) {
      signal?.throwIfAborted()
      try {
        const pRes = await fetch(`/api/pillars/${p.id}/principles`, { signal: signal ?? null })
        if (!pRes.ok) continue
        const pData = await pRes.json()
        const principles = pData?.principles ?? []
        for (const pr of principles) {
          if (pr.isNonNegotiable) {
            nnLines.push(`  ⚠️ [${p.name}] ${pr.statement}`)
          }
        }
      } catch { /* skip this pillar's principles */ }
    }

    if (nnLines.length > 0) {
      lines.push("")
      lines.push("🛡️ NON-NEGOTIABLE PRINCIPLES (AI MUST respect these):")
      lines.push(...nnLines)
      lines.push("")
      lines.push("IMPORTANT: Never suggest actions that violate Non-Negotiable Principles. If a task conflicts with these, flag it explicitly.")
    }

    return lines.join("\n")
  } catch {
    return null
  }
}

/**
 * Fetch active habit streaks for AI context.
 * Best-effort — returns null if unavailable.
 */
async function fetchHabitContext(signal?: AbortSignal): Promise<string | null> {
  try {
    const res = await fetch("/api/habits", { signal: signal ?? null })
    if (!res.ok) return null;
    const data = await res.json();
    const habits = data?.habits ?? data ?? [];
    if (!Array.isArray(habits) || habits.length === 0) return null;

    return habits
      .filter((h: { active?: boolean }) => h.active !== false)
      .map((h: { name: string; currentStreak?: number; completedToday?: boolean; targetCount?: number }) =>
        `- ${h.name}: ${h.currentStreak ?? 0} day streak${h.completedToday ? " ✅" : ""} (target: ${h.targetCount ?? 1}x/day)`)
      .join("\n");
  } catch {
    return null;
  }
}

/**
 * Ask AI about a task — sends to HA Assist with inline response.
 * Enriched with calendar schedule + habit context for holistic awareness.
 * Falls back to clipboard + external if HA is disconnected.
 */
export async function askAIForTask(taskId: string, signal?: AbortSignal): Promise<AIResult> {
  let target = await resolveAiHandoffTarget(signal)
  if (!target || signal?.aborted) return { source: "none" }
  if (target.provider === "ha_llm" && !target.canUseAssist) {
    showToast("settings.ai_handoff_ha_denied", "error")
    return { source: "none" }
  }
  const task = await resolveTask(taskId, signal)
  const type = task.taskType ?? task.task_type ?? "Task";

  // Fetch contextual data in parallel (best-effort, non-blocking)
  const [calendarContext, habitContext, pillarContext] = await Promise.all([
    fetchCalendarContext(signal),
    fetchHabitContext(signal),
    fetchPillarContext(signal),
  ]);
  if (signal?.aborted) return { source: "none" }

  let prompt = `I am working on the following ${type} in Meitheal. Help me plan, break down, or solve blocking issues.

Title: ${task.title}
Status: ${task.status}
Priority: ${task.priority ?? "None"}
Due Date: ${task.dueDate ?? "No due date"}

Description:
${task.description || "No description provided."}`;

  if (calendarContext) {
    prompt += `\n\nToday's Schedule:\n${calendarContext}`;
  }
  if (habitContext) {
    prompt += `\n\nActive Habits:\n${habitContext}`;
  }
  if (pillarContext) {
    prompt += `\n\n${pillarContext}`;
  }

  prompt += `\n\nPlease act as a senior technical co-pilot. Break this down into actionable sub-tasks or suggest the next step. Consider my schedule, active habits, and Pillar alignment when planning.`;

  if (target.canUseAssist) {
    try {
      const result = await callAssist(prompt, signal)
      if (result && !signal?.aborted) {
        return { response: result.speech, source: "ha-assist", conversationId: result.conversationId }
      }
    } catch (err) {
      if (!signal?.aborted) log.warn("HA Assist call failed", err)
    }
  }

  if (signal?.aborted) return { source: "none" }
  if (target.provider !== "ha_llm") target = await resolveAiHandoffTarget(signal)
  if (!target || signal?.aborted) return { source: "none" }
  if (target.provider === "ha_llm") {
    showToast(target.canUseAssist ? "settings.ai_handoff_ha_unavailable" : "settings.ai_handoff_ha_denied", "error")
    return { source: "none" }
  }
  if (!target.url) {
    showToast("settings.ai_handoff_url_invalid", "error")
    return { source: "none" }
  }
  return fallbackToClipboard(target.url, prompt, signal)
}

/**
 * Auto-score a task against strategic frameworks via HA Assist.
 * Returns structured field suggestions that can fill evaluator sliders.
 */
export async function autoScoreTask(
  taskId: string,
  frameworks: Array<{
    id: string;
    name: string;
    archetype: string;
    fields: Array<{
      key: string;
      label: string;
      help_text?: string | undefined
      description?: string | undefined
      min?: number | undefined
      max?: number | undefined
      options?: Array<{ label: string; value: string | number }> | undefined
    }>;
  }>,
  signal?: AbortSignal,
): Promise<{
  scores: Record<string, Record<string, number | string>>;
  justification: string;
  source: "ha-assist";
}> {
  const task = await resolveTask(taskId, signal)

  let prompt = `Score the following task against strategic frameworks. Return a JSON object with keys for each framework ID, and values being objects mapping field keys to suggested values.

Task: "${task.title}"
Status: ${task.status}
Priority: ${task.priority ?? "None"}
Description: ${task.description || "No description."}

Frameworks to evaluate:
`;

  for (const fw of frameworks) {
    prompt += `\n**${fw.name}** (ID: "${fw.id}", type: ${fw.archetype})\n`;
    for (const f of fw.fields) {
      prompt += `- ${f.label} (key: "${f.key}")`;
      if (f.help_text || f.description) prompt += `: ${f.help_text || f.description}`;
      if (f.min !== undefined && f.max !== undefined) {
        prompt += ` [range: ${f.min}–${f.max}]`;
      }
      if (f.options) {
        prompt += ` [options: ${f.options.map((o) => `${o.label}=${o.value}`).join(", ")}]`;
      }
      prompt += "\n";
    }
  }

  prompt += `
Respond with ONLY a JSON object in this exact format, no markdown fences:
{
  "scores": { "<framework_id>": { "<field_key>": <value>, ... }, ... },
  "justification": "Brief 1-2 sentence explanation of your scoring rationale."
}`;

  const result = await callAssist(prompt, signal)
  if (!result) throw new Error("Home Assistant Assist is unavailable")
  const parsed = extractJSON(result.speech)
  return {
    scores: parsed?.scores ?? {},
    justification: parsed?.justification || result.speech,
    source: "ha-assist",
  }
}

/**
 * Extract JSON from a potentially messy AI response (may include
 * markdown fences, preamble text, etc.).
 */
function extractJSON(
  text: string
): { scores: Record<string, Record<string, number | string>>; justification?: string } | null {
  try {
    // Try direct parse first
    return JSON.parse(text);
  } catch {
    /* not pure JSON */
  }

  // Try to find JSON block in markdown fences
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) {
    try {
      return JSON.parse(fenceMatch[1]!.trim());
    } catch {
      /* malformed */
    }
  }

  // Try to find first { ... } block
  const braceMatch = text.match(/\{[\s\S]*\}/);
  if (braceMatch) {
    try {
      return JSON.parse(braceMatch[0]);
    } catch {
      /* malformed */
    }
  }

  return null;
}
