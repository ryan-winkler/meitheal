import { expect, test } from "@playwright/test"
import {
  bindingAllows, parseWorkDestinations, selectWorkBinding,
} from "../../apps/web/src/domains/tasks/integration-destinations"

const original = () => ({ version: 1, revision: "revision-1", bindings: [{
  id: "calendar-source-1", generation: 1, integration: "calendar", sourceId: "calendar.example",
  purpose: "calendar.sync", enabled: true, destination: { boardId: "opaque-board-1", areaId: "area-1" },
  allowedOperations: [{ resource: "task", action: "create" }],
}] })

test("a saved destination is explicit and does not depend on Board names or capture defaults", () => {
  const stored = { ...original(), captureDefault: "different-board", boardName: "Church", credential: "must-not-project" }
  const config = parseWorkDestinations(JSON.stringify(stored))
  expect(config).not.toBeNull()
  const binding = selectWorkBinding(config, "calendar-source-1", 1)!
  expect(binding.destination).toEqual({ boardId: "opaque-board-1", areaId: "area-1" })
  expect(bindingAllows(binding, { resource: "task", action: "create" })).toBe(true)
  expect(bindingAllows(binding, { resource: "task", action: "complete" })).toBe(false)
  expect(JSON.stringify(config)).not.toContain("must-not-project")
  expect(Object.isFrozen(binding.destination)).toBe(true)
})

test("missing, disabled and replaced original bindings never fall back to another destination", () => {
  const data = original()
  data.bindings.push({ ...data.bindings[0]!, id: "replacement", generation: 2,
    destination: { boardId: "other-board", areaId: "other-area" } })
  data.bindings[0]!.enabled = false
  const config = parseWorkDestinations(data)
  expect(selectWorkBinding(config, "calendar-source-1", 1)).toBeNull()
  expect(selectWorkBinding(config, "replacement", 1)).toBeNull()
  expect(selectWorkBinding(config, "missing", 1)).toBeNull()
  expect(selectWorkBinding(config, "replacement", 2)?.destination.boardId).toBe("other-board")
})

test("malformed authority metadata fails closed rather than partially enrolling sources", () => {
  const malformed: unknown[] = [null, {}, "{", { ...original(), version: 2 }]
  for (const mutate of [
    (value: any) => { value.bindings.push(value.bindings[0]) },
    (value: any) => { value.bindings[0].generation = 0 },
    (value: any) => { value.bindings[0].generation = 1.5 },
    (value: any) => { value.bindings[0].destination = {} },
    (value: any) => { delete value.bindings[0].purpose },
    (value: any) => { value.bindings[0].allowedOperations = [{ resource: "task", action: "anything" }] },
    (value: any) => { value.bindings[0].allowedOperations = [] },
    (value: any) => { value.bindings[0].allowedOperations.push(value.bindings[0].allowedOperations[0]) },
    (value: any) => { value.bindings[0].recipientUserIds = ["user", "user"] },
    (value: any) => { value.bindings[0].recipientUserIds = [""] },
  ]) {
    const value = original()
    mutate(value)
    malformed.push(value)
  }
  for (const value of malformed) expect(parseWorkDestinations(value)).toBeNull()
})
