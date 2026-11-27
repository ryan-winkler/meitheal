import { expect, test } from "@playwright/test"
import { readTaskFrameworkPayload } from "../../apps/web/src/lib/task-api-client"

test.describe("Task framework metadata", () => {
  const taskId = "task-1"
  const frameworkValues = { rice: { reach: 0, impact: 2 }, checklist: { enabled: false } }

  test("reads current and stored framework values without losing zero or false", () => {
    expect(readTaskFrameworkPayload({ id: taskId, framework_payload: frameworkValues }, taskId)).toEqual(frameworkValues)
    expect(readTaskFrameworkPayload({ id: taskId, framework_payload: JSON.stringify(frameworkValues) }, taskId)).toEqual(frameworkValues)
    expect(readTaskFrameworkPayload({ id: taskId, framework_payload: null }, taskId)).toEqual({})
  })

  test("rejects a response without metadata for the requested task", () => {
    for (const task of [null, "task-1", {}, { id: taskId }, { id: "task-2", framework_payload: frameworkValues }]) {
      expect(() => readTaskFrameworkPayload(task, taskId)).toThrow("Invalid task metadata response")
    }
  })

  test("rejects framework values that cannot be merged as a record", () => {
    for (const framework_payload of [undefined, [], "[]", "null", false, 1, '\"text\"']) {
      expect(() => readTaskFrameworkPayload({ id: taskId, framework_payload }, taskId)).toThrow("Invalid task framework values")
    }
    expect(() => readTaskFrameworkPayload({ id: taskId, framework_payload: "{" }, taskId)).toThrow(SyntaxError)
  })
})
