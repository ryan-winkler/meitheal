import { expect, test } from "@playwright/test"
import { isAssignedTaskScopedRoute, resolveAgentRouteScope } from "../../packages/domain-auth/src/agent-route-policy"

test("agent route policy correctly classifies assigned-only write routes", () => {
  // /api/tasks/[id] allows PUT/PATCH with tasks:write:assigned
  expect(isAssignedTaskScopedRoute("/api/tasks/task-123", "PUT")).toBe(true)
  expect(isAssignedTaskScopedRoute("/api/tasks/task-123", "PATCH")).toBe(true)
  expect(isAssignedTaskScopedRoute("/api/tasks/task-123", "GET")).toBe(false)
  expect(isAssignedTaskScopedRoute("/api/tasks/task-123", "DELETE")).toBe(false)

  // Sub-resources under /api/tasks/[id]
  expect(isAssignedTaskScopedRoute("/api/tasks/task-123/comments", "POST")).toBe(true)
  expect(isAssignedTaskScopedRoute("/api/tasks/task-123/links", "POST")).toBe(true)
  expect(isAssignedTaskScopedRoute("/api/tasks/task-123/links", "DELETE")).toBe(true)
  expect(isAssignedTaskScopedRoute("/api/tasks/task-123/time", "POST")).toBe(true)
  expect(isAssignedTaskScopedRoute("/api/tasks/task-123/deferral", "PATCH")).toBe(true)

  // Top-level creation / deletion is NOT assigned-only
  expect(isAssignedTaskScopedRoute("/api/tasks", "POST")).toBe(false)
  expect(isAssignedTaskScopedRoute("/api/tasks/create", "POST")).toBe(false)
  expect(isAssignedTaskScopedRoute("/api/tasks/clear-completed", "POST")).toBe(false)
})

test("agent route policy maps standard routes to primary scopes", () => {
  expect(resolveAgentRouteScope("/api/tasks", "GET")).toBe("tasks:read")
  expect(resolveAgentRouteScope("/api/tasks", "POST")).toBe("tasks:write")
  expect(resolveAgentRouteScope("/api/tasks", "DELETE")).toBe("tasks:delete")
  expect(resolveAgentRouteScope("/api/mcp", "POST")).toBe("mcp:execute")
  expect(resolveAgentRouteScope("/api/search", "GET")).toBe("search:read")
  expect(resolveAgentRouteScope("/api/unknown", "GET")).toBeUndefined()
})
