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
import { t } from "../../i18n/client"

const log = createClientLogger("ai", "context");

/** Extended task interface with optional fields from persistence layer */
interface TaskWithExtras extends OfflineTask {
  taskType?: string;
  task_type?: string;
}

/** Result from an AI call — either inline response or fallback */
export interface AIResult {
  /** The AI's response text, or null if we fell back to clipboard */
  response: string | null;
  /** Whether we used HA Assist or fell back to external provider */
  source: "ha-assist" | "clipboard-fallback";
  /** Conversation ID for multi-turn follow-ups */
  conversationId?: string | undefined;
}

/**
 * Get the configured HA conversation agent ID from settings.
 * Falls back to undefined (HA's default agent).
 */
async function getAgentId(): Promise<string | undefined> {
  try {
    const res = await fetch(
      (window.__ingress_path || "") + "/api/settings?key=ha-agent-id"
    );
    if (res.ok) {
      const data = await res.json();
      if (data?.value && typeof data.value === "string") return data.value;
    }
  } catch {
    /* use default */
  }
  return undefined;
}

/**
 * Fetch full task data from offline store or API.
 */
async function resolveTask(taskId: string): Promise<TaskWithExtras> {
  let raw = await getTask(taskId);

  if (!raw) {
    try {
      const res = await fetch(
        `${window.__ingress_path || ""}/api/tasks/${taskId}`
      );
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
  conversationId?: string
): Promise<{ speech: string; conversationId?: string } | null> {
  const agentId = await getAgentId();

  const body: Record<string, string> = { text: prompt };
  if (agentId) body.agent_id = agentId;
  if (conversationId) body.conversation_id = conversationId;

  const res = await fetch(
    (window.__ingress_path || "") + "/api/ha/assist",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
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

type AiProvider = "chatgpt" | "claude" | "gemini" | "ollama" | "ha_llm" | "custom"
type AiHandoffTarget = { provider: "ha_llm" } | { provider: Exclude<AiProvider, "ha_llm">; url: URL }

/** Resolve the authoritative saved provider before either UI opens a destination. */
export async function resolveAiHandoffTarget(signal?: AbortSignal): Promise<AiHandoffTarget | null> {
  if (signal?.aborted) return null
  let provider: AiProvider = "chatgpt"
  try {
    const response = await fetch("/api/settings?key=ai-provider", { signal: signal ?? null, cache: "no-store" })
    if (!response.ok) throw new Error("Provider settings unavailable")
    const data: unknown = await response.json()
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Invalid provider setting")
    const value = (data as Record<string, unknown>).value
    if (value != null && value !== "") {
      if (typeof value !== "string" || !["chatgpt", "claude", "gemini", "ollama", "ha_llm", "custom"].includes(value)) throw new Error("Invalid provider setting")
      provider = value as AiProvider
    }
  } catch {
    if (!signal?.aborted) showToast("settings.ai_handoff_provider_unavailable", "error")
    return null
  }
  if (signal?.aborted) return null
  if (provider === "ha_llm") return { provider }

  let targetUrl = "https://chatgpt.com/"
  if (provider === "claude") targetUrl = "https://claude.ai/new"
  else if (provider === "gemini") targetUrl = "https://gemini.google.com/"
  else if (provider === "ollama" || provider === "custom") {
    let configured: unknown
    try {
      const response = await fetch("/api/settings?key=ai-custom-url", { signal: signal ?? null, cache: "no-store" })
      if (!response.ok) throw new Error("Provider settings unavailable")
      configured = (await response.json())?.value
    } catch {
      if (!signal?.aborted) showToast("settings.ai_handoff_url_unavailable", "error")
      return null
    }
    const url = parseAiHandoffUrl(configured)
    if (!url) {
      if (!signal?.aborted) showToast("settings.ai_handoff_url_invalid", "error")
      return null
    }
    targetUrl = url.href
  }
  return signal?.aborted ? null : { provider, url: new URL(targetUrl) }
}

/** Keep external navigation on a fresh native link gesture after settings resolve. */
export async function offerAiHandoff(url: URL, signal?: AbortSignal): Promise<void> {
  const locale = window.mI18n?.locale === "ga" ? "ga" : "en"
  await confirmDialog({
    title: t("settings.ai_handoff_open", locale),
    message: t("settings.ai_handoff_review", locale, { host: url.host }),
    confirmText: t("settings.ai_handoff_open", locale),
    confirmUrl: url,
    cancelText: t("common.cancel", locale),
    ...(signal ? { signal } : {}),
  })
}

/** Fall back to clipboard and the saved external provider when Assist is unavailable. */
async function fallbackToClipboard(prompt: string): Promise<void> {
  if (navigator.clipboard && window.isSecureContext) {
    try { await navigator.clipboard.writeText(prompt) } catch { /* clipboard denied */ }
  }
  const target = await resolveAiHandoffTarget()
  if (target?.provider === "ha_llm") showToast("settings.ai_handoff_ha_unavailable", "error")
  else if (target) await offerAiHandoff(target.url)
}

/**
 * Fetch today's calendar events for AI context.
 * Best-effort — returns null if unavailable.
 */
async function fetchCalendarContext(): Promise<string | null> {
  try {
    // Get configured calendar entities
    const settingsRes = await fetch(
      (window.__ingress_path || "") + "/api/settings?key=calendar-entities"
    );
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
        `${window.__ingress_path || ""}/api/ha/events?entity_id=${encodeURIComponent(entityId)}&start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`
      );
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
async function fetchPillarContext(): Promise<string | null> {
  try {
    const res = await fetch("/api/pillars")
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
      try {
        const pRes = await fetch(
          `/api/pillars/${p.id}/principles`
        )
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
async function fetchHabitContext(): Promise<string | null> {
  try {
    const res = await fetch(
      (window.__ingress_path || "") + "/api/habits"
    );
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
export async function askAIForTask(taskId: string): Promise<AIResult> {
  const task = await resolveTask(taskId);
  const type = task.taskType ?? task.task_type ?? "Task";

  // Fetch contextual data in parallel (best-effort, non-blocking)
  const [calendarContext, habitContext, pillarContext] = await Promise.all([
    fetchCalendarContext(),
    fetchHabitContext(),
    fetchPillarContext(),
  ]);

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

  try {
    const result = await callAssist(prompt);
    if (result) {
      return {
        response: result.speech,
        source: "ha-assist",
        conversationId: result.conversationId,
      };
    }
  } catch (err) {
    log.warn("HA Assist call failed, falling back", err);
  }

  // Fallback
  await fallbackToClipboard(prompt);
  return { response: null, source: "clipboard-fallback" };
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
  }>
): Promise<{
  scores: Record<string, Record<string, number | string>>;
  justification: string;
  source: "ha-assist" | "clipboard-fallback";
}> {
  const task = await resolveTask(taskId);

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

  try {
    const result = await callAssist(prompt);
    if (result) {
      // Try to parse structured JSON from the response
      const parsed = extractJSON(result.speech);
      if (parsed?.scores) {
        return {
          scores: parsed.scores,
          justification: parsed.justification || result.speech,
          source: "ha-assist",
        };
      }
      // If AI returned text but not parseable JSON, return it as justification
      return {
        scores: {},
        justification: result.speech,
        source: "ha-assist",
      };
    }
  } catch (err) {
    log.warn("Auto-score via Assist failed", err);
  }

  // Fallback: clipboard
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(prompt);
    } catch {
      /* denied */
    }
  }

  return {
    scores: {},
    justification: "HA Assist unavailable — prompt copied to clipboard. Paste into your AI provider.",
    source: "clipboard-fallback",
  };
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
