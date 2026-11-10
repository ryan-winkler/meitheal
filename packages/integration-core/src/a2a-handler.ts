/**
 * A2A (Agent-to-Agent) Protocol Handler
 *
 * Implements the HTTP+JSON/REST binding of the A2A Protocol RC v1.0.
 * Handles agent discovery (Agent Card), message routing, and task lifecycle.
 * See: https://a2a-protocol.org/latest/specification/
 *
 * Domain: integration-core
 * KCS: All A2A interactions are logged and emit domain events.
 *       Skill definitions are maintained here; tool schemas come from tool-registry.ts.
 */

import { getToolsByTag } from "./tool-registry"
import type { ToolDefinition } from "./tool-registry"

// --- A2A Protocol Data Types (§4) ---

export interface A2AAgentCard {
  name: string;
  description: string;
  url: string;
  supportedInterfaces: A2AAgentInterface[];
  provider: A2AAgentProvider;
  version: string;
  documentationUrl?: string;
  capabilities: A2AAgentCapabilities;
  defaultInputModes: string[];
  defaultOutputModes: string[];
  skills: A2AAgentSkill[];
  iconUrl?: string;
}

export interface A2AAgentInterface {
  url: string;
  protocolBinding: "JSONRPC" | "GRPC" | "HTTP+JSON";
  protocolVersion: string;
  authentication?: Record<string, unknown>;
}

export interface A2AAgentProvider {
  organization: string;
  url: string;
}

export interface A2AAgentCapabilities {
  streaming: boolean;
  pushNotifications: boolean;
  extendedAgentCard?: boolean;
  securityScheme?: string;
}

export interface A2AAgentSkill {
  id: string;
  name: string;
  description: string;
  tags: string[];
  examples: string[];
  inputModes?: string[];
  outputModes?: string[];
}

// --- A2A Message Types ---

export interface A2APart {
  text?: string;
  data?: unknown;
  mediaType?: string;
  metadata?: Record<string, unknown>;
}

export interface A2AMessage {
  role: "user" | "agent";
  messageId: string;
  parts: A2APart[];
  metadata?: Record<string, unknown>;
}

export type A2ATaskStatus =
  | "submitted"
  | "working"
  | "input-required"
  | "completed"
  | "canceled"
  | "failed";

export interface A2ATask {
  id: string;
  status: A2ATaskStatus;
  messages: A2AMessage[];
  artifacts?: A2AArtifact[];
  metadata?: Record<string, unknown>;
}

export interface A2AArtifact {
  name: string;
  parts: A2APart[];
  metadata?: Record<string, unknown>;
}

// --- A2A Error Codes ---

export interface A2AError {
  code: number;
  message: string;
  data?: unknown;
}

export const A2A_ERRORS = {
  TASK_NOT_FOUND: { code: -32001, message: "Task not found" },
  INVALID_SKILL: { code: -32002, message: "Unknown or unsupported skill" },
  INVALID_REQUEST: { code: -32600, message: "Invalid request" },
  METHOD_NOT_FOUND: { code: -32601, message: "Method not found" },
  INTERNAL_ERROR: { code: -32603, message: "Internal error" },
  NOT_SUPPORTED: { code: -32004, message: "Operation not supported" },
} as const;

// --- Skill Registry ---

export interface SkillHandler {
  skill: A2AAgentSkill;
  handle(message: A2AMessage): Promise<A2ATask>;
}

/**
 * Maps A2A skill IDs to the tool-registry tags they correspond to.
 * This enables A2A skill handlers to discover which tools they can call.
 */
export const SKILL_TO_TOOL_TAGS: Record<string, string[]> = {
  "task-management": ["tasks", "crud"],
  "task-search": ["tasks", "search"],
  "framework-scoring": ["scoring", "frameworks"],
  "data-export": ["export"],
  "areas": ["areas", "hierarchy"],
  "labels": ["labels"],
  "today-summary": ["today", "briefing"],
  "habits": ["habits"],
  "review-weekly": ["review"],
  "ha-calendar-sync": ["calendar", "sync"],
  "ha-entity-state": ["home-assistant", "entities"],
}

/**
 * Get the tool definitions available for a given A2A skill.
 * Returns tools from the shared registry matching any of the skill's mapped tags.
 */
export function getToolsForSkill(skillId: string): ToolDefinition[] {
  const tags = SKILL_TO_TOOL_TAGS[skillId]
  if (!tags) return []
  const tools = new Map<string, ToolDefinition>()
  for (const tag of tags) {
    for (const tool of getToolsByTag(tag)) {
      tools.set(tool.name, tool)
    }
  }
  return [...tools.values()]
}

/**
 * Meitheal's default A2A skills — derived from existing API capabilities.
 * Skills are conditionally included based on configured integrations.
 */
export const MEITHEAL_SKILLS: A2AAgentSkill[] = [
  {
    id: "task-management",
    name: "Task Management",
    description:
      "Create, read, update, and delete tasks in Meitheal. Supports titles, descriptions, priorities (1-5), statuses (todo/in_progress/done/cancelled), labels, story points, and due dates.",
    tags: ["tasks", "crud", "project-management"],
    examples: [
      "Create a task titled 'Fix login bug' with priority 1",
      "List all tasks with status 'in_progress'",
      '{"action": "create", "title": "Deploy v2", "priority": 2, "labels": ["release"]}',
    ],
    inputModes: ["application/json", "text/plain"],
    outputModes: ["application/json"],
  },
  {
    id: "task-search",
    name: "Task Search",
    description:
      "Search and filter tasks by status, priority, labels, due date, or free text. Returns matching tasks with full metadata.",
    tags: ["tasks", "search", "filter"],
    examples: [
      "Find all high-priority tasks due this week",
      '{"query": "bug", "status": "todo", "priority_gte": 3}',
    ],
    inputModes: ["application/json", "text/plain"],
    outputModes: ["application/json"],
  },
  {
    id: "framework-scoring",
    name: "Framework Scoring",
    description:
      "Apply product management frameworks (RICE, DRICE, HEART, KCS, DDD) to score and prioritize tasks. Returns computed scores.",
    tags: ["scoring", "prioritization", "rice", "frameworks"],
    examples: [
      "Score task MTH-42 using RICE framework",
      '{"task_id": "42", "framework": "rice", "reach": 100, "impact": 3, "confidence": 0.8, "effort": 5}',
    ],
    inputModes: ["application/json"],
    outputModes: ["application/json"],
  },
  {
    id: "data-export",
    name: "Data Export",
    description:
      "Export tasks in JSON or CSV format. Can export all tasks or filter by criteria.",
    tags: ["export", "data", "backup"],
    examples: [
      "Export all tasks as JSON",
      '{"format": "csv", "status": "completed"}',
    ],
    inputModes: ["application/json", "text/plain"],
    outputModes: ["application/json", "text/csv"],
  },
  {
    id: "areas",
    name: "Area Management",
    description: "Create, read, update, and delete Areas (projects/domains) to organize tasks.",
    tags: ["areas", "projects", "organization"],
    examples: ["List all my areas", '{"action": "create", "name": "Work"}'],
    inputModes: ["application/json", "text/plain"],
    outputModes: ["application/json"],
  },
  {
    id: "labels",
    name: "Label Management",
    description: "Create, read, update, and delete task labels for categorization.",
    tags: ["labels", "tags", "categories"],
    examples: ["What labels do I have?", '{"action": "create", "name": "urgent"}'],
    inputModes: ["application/json", "text/plain"],
    outputModes: ["application/json"],
  },
  {
    id: "today-summary",
    name: "Today Summary",
    description: "Get a summary of tasks due today, carried forward, overdues, and daily gamification stats (streak, XP).",
    tags: ["today", "stats", "gamification"],
    examples: ["How many tasks are due today?", "What is my current streak?"],
    inputModes: ["application/json", "text/plain"],
    outputModes: ["application/json"],
  },
  {
    id: "habits",
    name: "Habits and Routines",
    description: "Manage and track daily habits and recurring routines.",
    tags: ["habits", "routines", "tracking"],
    examples: ["Did I complete my morning routine?", "Mark water intake as done"],
    inputModes: ["application/json", "text/plain"],
    outputModes: ["application/json"],
  },
  {
    id: "review-weekly",
    name: "Weekly Review",
    description: "Retrieve tasks completed in the past week and upcoming tasks for the next week to facilitate a weekly planning review.",
    tags: ["review", "planning", "weekly"],
    examples: ["Show me what I got done this week", "Help me plan my upcoming week"],
    inputModes: ["application/json", "text/plain"],
    outputModes: ["application/json"],
  },
];

/**
 * HA-specific skills — only included when HA connection is configured.
 */
export const HA_SKILLS: A2AAgentSkill[] = [
  {
    id: "ha-calendar-sync",
    name: "Calendar Sync",
    description:
      "Sync tasks with due dates to a Home Assistant calendar entity. Tasks appear as calendar events with priority color coding.",
    tags: ["calendar", "home-assistant", "sync"],
    examples: [
      "Sync all tasks with due dates to my HA calendar",
      '{"action": "sync", "entity_id": "calendar.meitheal_tasks"}',
    ],
    inputModes: ["application/json", "text/plain"],
    outputModes: ["application/json"],
  },
  {
    id: "ha-entity-state",
    name: "HA Entity State",
    description:
      "Read the current state of a Home Assistant entity. Useful for checking sensor values, switch states, or automation status.",
    tags: ["home-assistant", "entities", "state"],
    examples: [
      "What is the state of sensor.temperature?",
      '{"entity_id": "sensor.living_room_temperature"}',
    ],
    inputModes: ["application/json", "text/plain"],
    outputModes: ["application/json"],
  },
];

/**
 * Build the Meitheal Agent Card from current configuration.
 * Skills are dynamically included based on active integrations.
 */
export function buildAgentCard(options: {
  basePath: string;
  haConfigured: boolean;
}): A2AAgentCard {
  const skills = [...MEITHEAL_SKILLS];
  if (options.haConfigured) {
    skills.push(...HA_SKILLS);
  }

  return {
    name: "Meitheal",
    description:
      "Experimental Meitheal agent discovery. Skills list recognised message intents. The endpoints return sample responses.",
    url: options.basePath || "/",
    supportedInterfaces: [],
    provider: {
      organization: "Coolock Village",
      url: "https://github.com/ryan-winkler/meitheal",
    },
    version: "0.3.0",
    documentationUrl: `${options.basePath}/openapi.yaml`,
    capabilities: {
      streaming: false,
      pushNotifications: false,
      extendedAgentCard: false,
      securityScheme: "bearer",
    },
    defaultInputModes: ["application/json", "text/plain"],
    defaultOutputModes: ["application/json"],
    skills,
  };
}

/**
 * Route an incoming A2A message to the appropriate skill handler.
 * Extracts skill intent from message parts (structured JSON or natural language).
 */
export function extractSkillFromMessage(message: A2AMessage): string | null {
  for (const part of message.parts) {
    // Check structured data first
    if (part.data && typeof part.data === "object") {
      const data = part.data as Record<string, unknown>;
      if (typeof data.skill === "string") return data.skill;
    }

    // Check metadata
    if (
      message.metadata &&
      typeof message.metadata.skill === "string"
    ) {
      return message.metadata.skill;
    }

    // Check text for skill keywords
    if (part.text) {
      const text = part.text.toLowerCase();
      if (
        text.includes("create task") ||
        text.includes("new task") ||
        text.includes("add task") ||
        text.includes("update task") ||
        text.includes("delete task") ||
        text.includes("complete task") ||
        text.includes("assign task")
      ) {
        return "task-management";
      }
      if (
        text.includes("search") ||
        text.includes("find") ||
        text.includes("list tasks") ||
        text.includes("filter")
      ) {
        return "task-search";
      }
      if (
        text.includes("score") ||
        text.includes("rice") ||
        text.includes("prioriti") ||
        text.includes("framework")
      ) {
        return "framework-scoring";
      }
      if (text.includes("export") || text.includes("download")) {
        return "data-export";
      }
      if (text.includes("area") || text.includes("goal") || text.includes("project")) {
        return "areas";
      }
      if (text.includes("label") || text.includes("tag") || text.includes("categor")) {
        return "labels";
      }
      if (text.includes("today") || text.includes("briefing") || text.includes("morning") || text.includes("overdue")) {
        return "today-summary";
      }
      if (text.includes("habit") || text.includes("routine") || text.includes("streak")) {
        return "habits";
      }
      if (text.includes("weekly review") || text.includes("plan my week") || text.includes("what did I get done")) {
        return "review-weekly";
      }
      if (text.includes("calendar") || text.includes("sync")) {
        return "ha-calendar-sync";
      }
      if (text.includes("entity") || text.includes("sensor")) {
        return "ha-entity-state";
      }
    }
  }
  return null;
}

/**
 * Create a new A2A Task from an incoming message.
 */
export function createA2ATask(
  message: A2AMessage,
  status: A2ATaskStatus = "submitted"
): A2ATask {
  return {
    id: crypto.randomUUID(),
    status,
    messages: [message],
    metadata: {
      createdAt: new Date().toISOString(),
      skill: extractSkillFromMessage(message),
    },
  };
}
