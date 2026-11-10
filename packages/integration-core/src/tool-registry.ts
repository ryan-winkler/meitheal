/**
 * tool-registry.ts — Canonical tool definitions for all AI integration surfaces
 *
 * @domain integration-core
 * @kcs Single source of truth for MCP, A2A, and HA LLM tool schemas.
 *      When adding a new tool, define it here once. All surfaces consume from here.
 *
 * Each tool definition contains:
 * - Schema: name, description, inputSchema (JSON Schema)
 * - Metadata: tags, which surfaces support it, voice trigger phrases
 * - Execution: route key mapping to internal API endpoint
 *
 * Surfaces consume these definitions via helper accessors:
 * - getMcpTools() — MCP JSON-RPC tools/list format
 * - getA2ASkills() — A2A Agent Card skill format
 * - getLlmToolDescriptions() — HA LLM API descriptions
 */

// ── JSON Schema types ──

export interface ToolPropertySchema {
  type: string
  description?: string
  minimum?: number
  maximum?: number
  format?: string
  enum?: string[]
  items?: ToolPropertySchema
}

export interface ToolInputSchema {
  type: "object"
  required?: string[]
  properties: Record<string, ToolPropertySchema>
}

// ── Tool definition ──

export interface ToolDefinition {
  /** Canonical tool name (camelCase) */
  name: string
  /** Human-readable description for LLM context */
  description: string
  /** JSON Schema for tool input */
  inputSchema: ToolInputSchema
  /** Tags for categorisation and A2A skill mapping */
  tags: string[]
  /** Voice trigger phrases for HA Assist matching */
  voiceTriggers?: string[]
  /** Internal API route this tool delegates to */
  apiRoute: string
  /** HTTP method for the internal API call */
  apiMethod: "GET" | "POST" | "PUT" | "DELETE"
  /** Whether this tool requires HA connection */
  requiresHA?: boolean
}

// ── Canonical tool definitions ──

export const TOOL_REGISTRY: ToolDefinition[] = [
  // ─── Task CRUD ───
  {
    name: "createTask",
    description:
      "Create a new task with title, description, priority, urgency, importance, labels, and due date. " +
      "Use when the user says 'add a task', 'remind me to', 'create a todo', or 'I need to'.",
    inputSchema: {
      type: "object",
      required: ["title"],
      properties: {
        title: { type: "string", description: "Task title" },
        description: { type: "string", description: "Task description" },
        priority: { type: "integer", minimum: 1, maximum: 5, description: "Priority 1-5 (1=urgent)" },
        urgency: { type: "integer", minimum: 0, maximum: 5, description: "Urgency 0-5 (Eisenhower x-axis, 0=unclassified)" },
        importance: { type: "integer", minimum: 0, maximum: 5, description: "Importance 0-5 (Eisenhower y-axis, 0=unclassified)" },
        due_date: { type: "string", format: "date", description: "Due date YYYY-MM-DD" },
        assigned_to: { type: "string", description: "User ID to assign the task to" },
      },
    },
    tags: ["tasks", "crud"],
    voiceTriggers: ["add a task", "remind me to", "create a todo", "I need to"],
    apiRoute: "/api/tasks/create",
    apiMethod: "POST",
  },
  {
    name: "searchTasks",
    description:
      "Search tasks by keyword, status, priority, urgency, importance, Eisenhower quadrant, assignee, labels, custom fields, comments, or task IDs.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search keyword" },
        status: { type: "string", enum: ["backlog", "pending", "active", "complete"] },
        priority: { type: "integer", minimum: 1, maximum: 5 },
        urgency: { type: "integer", minimum: 0, maximum: 5, description: "Filter by urgency (Eisenhower)" },
        importance: { type: "integer", minimum: 0, maximum: 5, description: "Filter by importance (Eisenhower)" },
        eisenhower_quadrant: { type: "string", enum: ["do-first", "schedule", "delegate", "not-now"], description: "Filter by Eisenhower quadrant" },
        assigned_to: { type: "string", description: "Filter by assigned user ID" },
        include_completed: { type: "boolean" },
      },
    },
    tags: ["tasks", "search", "filter"],
    voiceTriggers: ["search tasks", "find tasks", "list tasks", "what tasks"],
    apiRoute: "/api/search",
    apiMethod: "GET",
  },
  {
    name: "completeTask",
    description: "Mark a task as done by ID or title. Use when the user says 'done', 'complete', 'finished', or 'mark as done'.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Task UUID" },
        title: { type: "string", description: "Task title (fuzzy match)" },
      },
    },
    tags: ["tasks", "crud"],
    voiceTriggers: ["done", "complete", "finished", "mark as done"],
    apiRoute: "/api/tasks/{id}",
    apiMethod: "PUT",
  },
  {
    name: "updateTask",
    description: "Update task fields including Eisenhower urgency/importance, priority, due date, status, description.",
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "string", description: "Task UUID" },
        title: { type: "string" },
        status: { type: "string", enum: ["backlog", "pending", "active", "complete"] },
        priority: { type: "integer", minimum: 1, maximum: 5 },
        urgency: { type: "integer", minimum: 0, maximum: 5, description: "Urgency 0-5 (Eisenhower x-axis)" },
        importance: { type: "integer", minimum: 0, maximum: 5, description: "Importance 0-5 (Eisenhower y-axis)" },
        eisenhower_override: { type: "boolean", description: "Set true if manually placed in quadrant" },
        due_date: { type: "string", format: "date" },
        description: { type: "string" },
      },
    },
    tags: ["tasks", "crud"],
    voiceTriggers: ["change", "update", "set priority", "reschedule", "modify"],
    apiRoute: "/api/tasks/{id}",
    apiMethod: "PUT",
  },
  {
    name: "deleteTask",
    description: "Delete a task by ID. Use when the user says 'delete', 'remove', 'get rid of' a task.",
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "string", description: "Task UUID" },
      },
    },
    tags: ["tasks", "crud"],
    voiceTriggers: ["delete", "remove", "get rid of"],
    apiRoute: "/api/tasks/{id}",
    apiMethod: "DELETE",
  },
  {
    name: "getTask",
    description: "Get full details of a specific task by ID.",
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "string", description: "Task UUID" },
      },
    },
    tags: ["tasks", "read"],
    apiRoute: "/api/tasks/{id}",
    apiMethod: "GET",
  },

  // ─── Task Queries ───
  {
    name: "getOverdueTasks",
    description: "Get all overdue tasks — tasks past their due date that aren't done. Use when the user asks 'what's overdue?' or 'any late tasks?'.",
    inputSchema: { type: "object", properties: {} },
    tags: ["tasks", "read", "overdue"],
    voiceTriggers: ["what's overdue", "any late tasks", "what did I miss"],
    apiRoute: "/api/tasks",
    apiMethod: "GET",
  },
  {
    name: "getTodaysTasks",
    description: "Get tasks due today plus any overdue tasks. Use when the user asks 'what's on my plate?' or 'today's tasks'.",
    inputSchema: { type: "object", properties: {} },
    tags: ["tasks", "read", "today"],
    voiceTriggers: ["what's on my plate", "today's tasks", "what do I need to do today"],
    apiRoute: "/api/tasks",
    apiMethod: "GET",
  },
  {
    name: "getTaskSummary",
    description: "Get summary counts: total, active, overdue, done. Use when the user asks 'how many tasks?' or 'how am I doing?'.",
    inputSchema: { type: "object", properties: {} },
    tags: ["tasks", "read", "summary"],
    voiceTriggers: ["how many tasks", "task status", "how am I doing", "overview"],
    apiRoute: "/api/tasks",
    apiMethod: "GET",
  },
  {
    name: "batchComplete",
    description: "Complete multiple tasks at once by label, priority filter, or specific titles.",
    inputSchema: {
      type: "object",
      properties: {
        label: { type: "string", description: "Only affect tasks with this label" },
        max_priority: { type: "integer", description: "Only affect tasks with priority <= this" },
        titles: { type: "array", items: { type: "string" }, description: "Specific task titles to complete" },
      },
    },
    tags: ["tasks", "crud", "batch"],
    voiceTriggers: ["clear all done", "mark everything done", "I finished all"],
    apiRoute: "/api/tasks",
    apiMethod: "POST",
  },

  // ─── Task Assignment ───
  {
    name: "assignTask",
    description: "Assign a task to a user (HA user or custom user) by task ID and user ID.",
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "string", description: "Task UUID" },
        assigned_to: { type: "string", description: "User ID to assign to (omit or null to unassign)" },
      },
    },
    tags: ["tasks", "users", "assignment"],
    apiRoute: "/api/tasks/{id}",
    apiMethod: "PUT",
  },
  {
    name: "listUsers",
    description: "List all available users (Home Assistant auto-discovered + custom users).",
    inputSchema: { type: "object", properties: {} },
    tags: ["users", "read"],
    apiRoute: "/api/users",
    apiMethod: "GET",
  },

  // ─── Task Links ───
  {
    name: "linkTask",
    description: "Create a Jira-style link between two tasks. Link types: related_to, blocked_by, blocks, duplicates, duplicated_by.",
    inputSchema: {
      type: "object",
      required: ["source_task_id", "target_task_id", "link_type"],
      properties: {
        source_task_id: { type: "string", description: "Source task UUID" },
        target_task_id: { type: "string", description: "Target task UUID" },
        link_type: { type: "string", enum: ["related_to", "blocked_by", "blocks", "duplicates", "duplicated_by"], description: "Relationship type" },
      },
    },
    tags: ["tasks", "links"],
    apiRoute: "/api/tasks/{source_task_id}/links",
    apiMethod: "POST",
  },
  {
    name: "unlinkTask",
    description: "Remove a link between two tasks by link ID.",
    inputSchema: {
      type: "object",
      required: ["task_id", "link_id"],
      properties: {
        task_id: { type: "string", description: "Task UUID the link belongs to" },
        link_id: { type: "string", description: "Link UUID to remove" },
      },
    },
    tags: ["tasks", "links"],
    apiRoute: "/api/tasks/{task_id}/links",
    apiMethod: "DELETE",
  },
  {
    name: "getTaskLinks",
    description: "Get all links for a task (outbound and inbound relationships).",
    inputSchema: {
      type: "object",
      required: ["task_id"],
      properties: {
        task_id: { type: "string", description: "Task UUID" },
      },
    },
    tags: ["tasks", "links", "read"],
    apiRoute: "/api/tasks/{task_id}/links",
    apiMethod: "GET",
  },

  // ─── Calendar ───
  {
    name: "getCalendarEvents",
    description: "Get events from the user's HA calendar synced into Meitheal. Use when the user asks 'what's on my calendar?'.",
    inputSchema: {
      type: "object",
      properties: {
        days_ahead: { type: "integer", minimum: 1, maximum: 30, description: "Days ahead to look (default: 7)" },
      },
    },
    tags: ["calendar", "read"],
    voiceTriggers: ["what's on my calendar", "any events", "show my calendar"],
    apiRoute: "/api/tasks",
    apiMethod: "GET",
  },
  {
    name: "getUpcoming",
    description: "Get all upcoming tasks and calendar events combined. Use when the user asks 'what's coming up?' or 'what do I have this week?'.",
    inputSchema: {
      type: "object",
      properties: {
        days_ahead: { type: "integer", minimum: 1, maximum: 30, description: "Days ahead to look (default: 7)" },
      },
    },
    tags: ["calendar", "tasks", "read"],
    voiceTriggers: ["what's coming up", "what's on my schedule", "what do I have this week"],
    apiRoute: "/api/tasks",
    apiMethod: "GET",
  },
  {
    name: "syncCalendar",
    description: "Trigger a manual calendar sync from Home Assistant.",
    inputSchema: {
      type: "object",
      properties: {
        entity_id: { type: "string", description: "Calendar entity ID (optional, uses configured entity if omitted)" },
      },
    },
    tags: ["calendar", "sync", "home-assistant"],
    requiresHA: true,
    apiRoute: "/api/integrations/calendar/sync",
    apiMethod: "POST",
  },

  // ─── Hierarchy (Areas, Goals, Projects) ───
  {
    name: "listAreas",
    description: "List all areas (top-level domains for organising goals and tasks).",
    inputSchema: { type: "object", properties: {} },
    tags: ["areas", "hierarchy", "read"],
    voiceTriggers: ["list my areas", "what areas do I have"],
    apiRoute: "/api/areas",
    apiMethod: "GET",
  },
  {
    name: "listGoals",
    description: "List all goals, optionally filtered by area.",
    inputSchema: {
      type: "object",
      properties: {
        area_id: { type: "string", description: "Filter by area ID" },
      },
    },
    tags: ["goals", "hierarchy", "read"],
    voiceTriggers: ["list my goals", "what goals do I have"],
    apiRoute: "/api/goals",
    apiMethod: "GET",
  },
  {
    name: "moveTask",
    description: "Move a task to a different project or area.",
    inputSchema: {
      type: "object",
      required: ["task_id"],
      properties: {
        task_id: { type: "string", description: "Task UUID to move" },
        project_id: { type: "string", description: "Target project ID" },
        area_id: { type: "string", description: "Target area ID (if no project)" },
      },
    },
    tags: ["tasks", "hierarchy", "crud"],
    apiRoute: "/api/tasks/{task_id}",
    apiMethod: "PUT",
  },
  {
    name: "setGoalProgress",
    description: "Update the progress percentage of a goal.",
    inputSchema: {
      type: "object",
      required: ["goal_id", "progress"],
      properties: {
        goal_id: { type: "string", description: "Goal UUID" },
        progress: { type: "integer", minimum: 0, maximum: 100, description: "Progress percentage" },
      },
    },
    tags: ["goals", "hierarchy", "crud"],
    apiRoute: "/api/goals/{goal_id}",
    apiMethod: "PUT",
  },

  // ─── Habits ───
  {
    name: "getHabits",
    description: "Get all habits and their current tracking status. Use when the user asks about routines or daily habits.",
    inputSchema: { type: "object", properties: {} },
    tags: ["habits", "read"],
    voiceTriggers: ["my habits", "morning routine", "daily habits", "did I complete"],
    apiRoute: "/api/habits",
    apiMethod: "GET",
  },
  {
    name: "completeHabit",
    description: "Mark a habit as completed for today. Use when the user says 'mark habit done' or refers to completing a routine.",
    inputSchema: {
      type: "object",
      required: ["templateId"],
      properties: {
        templateId: { type: "string", description: "Habit template ID" },
      },
    },
    tags: ["habits", "crud"],
    voiceTriggers: ["mark habit done", "completed routine", "did water intake"],
    apiRoute: "/api/habits",
    apiMethod: "POST",
  },

  // ─── Reviews ───
  {
    name: "getWeeklyReview",
    description: "Get tasks completed last week and upcoming tasks for weekly planning review.",
    inputSchema: { type: "object", properties: {} },
    tags: ["review", "read", "planning"],
    voiceTriggers: ["weekly review", "what did I get done", "plan my week"],
    apiRoute: "/api/review/weekly",
    apiMethod: "GET",
  },

  // ─── Scoring/Frameworks ───
  {
    name: "scoreTask",
    description: "Apply a product management framework (RICE, DRICE, HEART, KCS, DDD) to score and prioritize a task.",
    inputSchema: {
      type: "object",
      required: ["task_id", "framework"],
      properties: {
        task_id: { type: "string", description: "Task UUID" },
        framework: { type: "string", enum: ["rice", "drice", "heart", "kcs", "ddd"], description: "Framework to apply" },
        reach: { type: "integer", description: "RICE: estimated reach" },
        impact: { type: "integer", minimum: 1, maximum: 5, description: "RICE: impact score" },
        confidence: { type: "number", minimum: 0, maximum: 1, description: "RICE: confidence level" },
        effort: { type: "integer", minimum: 1, description: "RICE: effort in person-weeks" },
      },
    },
    tags: ["scoring", "frameworks", "strategy"],
    apiRoute: "/api/tasks/{task_id}/score",
    apiMethod: "POST",
  },

  // ─── Export ───
  {
    name: "exportTasks",
    description: "Export tasks in JSON or CSV format. Can export all tasks or filter by criteria.",
    inputSchema: {
      type: "object",
      properties: {
        format: { type: "string", enum: ["json", "csv"], description: "Export format (default: json)" },
        status: { type: "string", description: "Filter by status" },
      },
    },
    tags: ["export", "data"],
    apiRoute: "/api/export/tasks",
    apiMethod: "GET",
  },

  // ─── Labels ───
  {
    name: "listLabels",
    description: "List all available task labels for categorisation.",
    inputSchema: { type: "object", properties: {} },
    tags: ["labels", "read"],
    voiceTriggers: ["what labels do I have", "list labels"],
    apiRoute: "/api/labels",
    apiMethod: "GET",
  },

  // ─── Daily Briefing (HA-specific) ───
  {
    name: "dailyBriefing",
    description:
      "Get a comprehensive daily briefing combining today's tasks, calendar events, overdue items, and Home Assistant context (weather, who's home). " +
      "Use when the user says 'good morning', 'brief me', 'what's my day look like?'.",
    inputSchema: { type: "object", properties: {} },
    tags: ["briefing", "today", "home-assistant"],
    voiceTriggers: ["good morning", "brief me", "what's my day look like", "daily briefing", "start my day"],
    requiresHA: true,
    apiRoute: "/api/tasks",
    apiMethod: "GET",
  },

  // ─── HA Entity State ───
  {
    name: "getEntityState",
    description: "Read the current state of a Home Assistant entity. Useful for checking sensor values, switch states, or automation status.",
    inputSchema: {
      type: "object",
      required: ["entity_id"],
      properties: {
        entity_id: { type: "string", description: "HA entity ID (e.g., sensor.temperature)" },
      },
    },
    tags: ["home-assistant", "entities", "read"],
    voiceTriggers: ["what is the state of", "check sensor"],
    requiresHA: true,
    apiRoute: "/api/ha/entity",
    apiMethod: "GET",
  },
]

// ── Accessor helpers ──

/**
 * Get all tool definitions, optionally filtering by HA availability.
 */
export function getTools(options?: { haConfigured?: boolean }): ToolDefinition[] {
  if (options?.haConfigured === false) {
    return TOOL_REGISTRY.filter((tool) => !tool.requiresHA)
  }
  return [...TOOL_REGISTRY]
}

/**
 * Get tools formatted for MCP tools/list response.
 */
export function getMcpTools(options?: { haConfigured?: boolean }): Array<{
  name: string
  description: string
  inputSchema: ToolInputSchema
}> {
  return getTools(options).map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  }))
}

/**
 * Get a single tool definition by name.
 */
export function getToolByName(name: string): ToolDefinition | undefined {
  return TOOL_REGISTRY.find((tool) => tool.name === name)
}

/**
 * Get tools grouped by tag (for A2A skill mapping).
 */
export function getToolsByTag(tag: string): ToolDefinition[] {
  return TOOL_REGISTRY.filter((tool) => tool.tags.includes(tag))
}

/**
 * Get the total tool count.
 */
export function getToolCount(options?: { haConfigured?: boolean }): number {
  return getTools(options).length
}
