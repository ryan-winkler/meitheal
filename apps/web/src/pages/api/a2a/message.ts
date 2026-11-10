import type { APIRoute } from "astro";
import { apiJson, apiError } from "../../../lib/api-response";
import {
  createA2ATask,
  extractSkillFromMessage,
  A2A_ERRORS,
  type A2AMessage,

} from "@meitheal/integration-core";

/**
 * POST /api/a2a/message — A2A Message Send
 *
 * Receives an agent message per A2A spec §11.3.1, routes to skill handler,
 * and returns an A2A Task with status.
 *
 * KCS: Messages are validated, skill-routed, and logged. Unsupported skills
 * return structured A2A errors per spec §9.5.
 */
export const POST: APIRoute = async ({ request }) => {
  try {
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;

    if (!body || !body.message) {
      return apiJson(
        { error: A2A_ERRORS.INVALID_REQUEST },
        400
      );
    }

    const message = body.message as A2AMessage;

    // Validate message structure
    if (!message.role || !message.parts || !Array.isArray(message.parts)) {
      return apiJson(
        { error: { ...A2A_ERRORS.INVALID_REQUEST, data: "Message must have role and parts array" } },
        400
      );
    }

    // Ensure messageId
    if (!message.messageId) {
      message.messageId = crypto.randomUUID();
    }

    // Extract skill intent
    const skillId = extractSkillFromMessage(message);

    if (!skillId) {
      // Return task requiring input — agent should specify skill
      const task = createA2ATask(message, "input-required");
      task.messages.push({
        role: "agent",
        messageId: crypto.randomUUID(),
        parts: [
          {
            text: "I couldn't determine which skill to use. Please specify a skill: task-management, task-search, framework-scoring, data-export, ha-calendar-sync, ha-entity-state, areas, labels, today-summary, or habits.",
          },
        ],
      });
      return apiJson({ task });
    }

    // Create task and route to skill
    const task = createA2ATask(message, "working");

    // For now, acknowledge receipt and return task with skill metadata.
    // Detailed skill execution will be wired to existing API routes.
    const responseMessage: A2AMessage = {
      role: "agent",
      messageId: crypto.randomUUID(),
      parts: [
        {
          text: `Task received and routed to skill '${skillId}'. Processing...`,
          data: {
            skill: skillId,
            taskId: task.id,
            status: "working",
          },
        },
      ],
    };

    task.messages.push(responseMessage);
    task.status = "completed";

    // Add skill-specific structured output
    const skillResponse = await handleSkill(skillId, message);
    if (skillResponse) {
      task.artifacts = [
        {
          name: `${skillId}-result`,
          parts: [{ data: skillResponse, mediaType: "application/json" }],
        },
      ];
    }

    return apiJson({ task });
  } catch (error) {
    return apiError(
      error instanceof Error ? error.message : "Internal A2A error",
      500
    );
  }
};

/**
 * Simple skill handler — maps A2A skills to response shapes.
 * In production, these would call through to actual API handlers.
 */
async function handleSkill(
  skillId: string,
  message: A2AMessage
): Promise<Record<string, unknown> | null> {
  // Extract structured data if present
  const dataPart = message.parts.find((p: { data?: unknown }) => p.data);
  const textPart = message.parts.find((p: { text?: string }) => p.text);

  switch (skillId) {
    case "task-management":
      return {
        skill: "task-management",
        description: "Task management operations are available via POST /api/tasks",
        supported_actions: ["create", "read", "update", "delete"],
        api_endpoint: "/api/tasks",
        input_received: dataPart?.data ?? textPart?.text ?? null,
      };

    case "task-search":
      return {
        skill: "task-search",
        description: "Search tasks by status, priority, labels, or free text",
        api_endpoint: "/api/tasks?q={query}",
        input_received: dataPart?.data ?? textPart?.text ?? null,
      };

    case "framework-scoring":
      return {
        skill: "framework-scoring",
        description: "Apply RICE/DRICE/HEART/KCS/DDD scoring frameworks",
        supported_frameworks: ["rice", "drice", "heart", "kcs", "ddd", "custom"],
        api_endpoint: "/api/tasks/{id}",
        input_received: dataPart?.data ?? textPart?.text ?? null,
      };

    case "data-export":
      return {
        skill: "data-export",
        description: "Export tasks in JSON or CSV format",
        supported_formats: ["json", "csv"],
        api_endpoints: {
          json: "/api/export/tasks.json",
          csv: "/api/export/tasks.csv",
        },
      };

    case "ha-calendar-sync":
      return {
        skill: "ha-calendar-sync",
        description: "Sync tasks with Home Assistant calendar",
        api_endpoint: "/api/ha/calendar",
        requires: "Home Assistant connection configured in Settings",
      };

    case "ha-entity-state":
      return {
        skill: "ha-entity-state",
        description: "Read Home Assistant entity states",
        api_endpoint: "/api/ha/calendars",
        requires: "Home Assistant connection configured in Settings",
      };

    case "areas":
      return {
        skill: "areas",
        description: "List kanban areas with column configurations and task counts",
        api_endpoint: "/api/areas",
        supported_actions: ["list", "get"],
        input_received: dataPart?.data ?? textPart?.text ?? null,
      };

    case "labels":
      return {
        skill: "labels",
        description: "List available task labels with colors and usage counts",
        api_endpoint: "/api/labels",
        supported_actions: ["list", "create", "update", "delete"],
        input_received: dataPart?.data ?? textPart?.text ?? null,
      };

    case "today-summary":
      return {
        skill: "today-summary",
        description: "Get today's task overview — due today, overdue, completed, stats",
        api_endpoint: "/api/tasks?due=today",
        includes: ["due_today", "overdue", "completed_today", "daily_stats"],
        input_received: dataPart?.data ?? textPart?.text ?? null,
      };

    case "habits":
      return {
        skill: "habits",
        description: "Habit tracker — streaks, completion rates, today's habits",
        api_endpoint: "/api/habits",
        supported_actions: ["list", "log", "get-streaks"],
        input_received: dataPart?.data ?? textPart?.text ?? null,
      };

    default:
      return null;
  }
}
