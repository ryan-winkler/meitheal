import { expect, test } from "@playwright/test"

import { hydrateTaskAssignees } from "../../apps/web/src/lib/task-assignee-display"
import { taskApi, type AssigneeDirectory } from "../../apps/web/src/lib/task-api-client"

function surface(ids: string[], groups = false) {
  const labels = ids.map(id => ({ dataset: { taskAssignee: id }, textContent: id ? "Loading" : "Unassigned", parentElement: { title: "" } }))
  const root = { querySelectorAll: (selector: string) => selector === "[data-assignee-group]"
    ? groups ? labels : [] : labels.filter(label => label.dataset.taskAssignee) } as unknown as HTMLElement
  return { labels, root }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { resolve, promise }
}

const originalDirectory = taskApi.listUserDirectory
function setDirectory(read: typeof taskApi.listUserDirectory) {
  Object.defineProperty(taskApi, "listUserDirectory", { configurable: true, value: read })
}
let originalWindow: PropertyDescriptor | undefined

test.beforeEach(() => {
  originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window")
  Object.defineProperty(globalThis, "window", { configurable: true, value: { mI18n: { get: () => undefined } } })
})
test.afterEach(() => {
  setDirectory(originalDirectory)
  if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow)
  else Reflect.deleteProperty(globalThis, "window")
})

test("assignee directory requests share only the active render signal and can retry after settling", async () => {
  const directory = deferred<AssigneeDirectory>()
  let requests = 0
  setDirectory(() => { requests++; return directory.promise })
  const signal = new AbortController().signal
  const one = surface(["custom_a"])
  const two = surface(["custom_a"])
  const first = hydrateTaskAssignees(one.root, signal)
  const second = hydrateTaskAssignees(two.root, signal)
  expect(requests).toBe(1)
  directory.resolve({ users: [{ id: "custom_a", name: "Alex" }] })
  await Promise.all([first, second])
  expect(one.labels[0]!.textContent).toBe("Alex")
  expect(two.labels[0]!.textContent).toBe("Alex")
  await hydrateTaskAssignees(one.root, signal)
  expect(requests).toBe(2)
})

test("an aborted old directory cannot overwrite a newer render", async () => {
  const old = deferred<AssigneeDirectory>()
  const fresh = deferred<AssigneeDirectory>()
  const oldLifetime = new AbortController()
  setDirectory(signal => signal === oldLifetime.signal ? old.promise : fresh.promise)
  const oldSurface = surface(["custom_a"])
  const newSurface = surface(["custom_a"])
  const before = hydrateTaskAssignees(oldSurface.root, oldLifetime.signal)
  oldLifetime.abort()
  const after = hydrateTaskAssignees(newSurface.root, new AbortController().signal)
  fresh.resolve({ users: [{ id: "custom_a", name: "Current name" }] })
  await after
  old.resolve({ users: [{ id: "custom_a", name: "Older name" }] })
  await before
  expect(oldSurface.labels[0]!.textContent).toBe("Loading")
  expect(newSurface.labels[0]!.textContent).toBe("Current name")
})

test("directory failures, unverified members and normalized duplicate names keep distinct readable groups", async () => {
  setDirectory(async () => { throw new Error("directory offline") })
  const failed = surface(["ha_missing"])
  await hydrateTaskAssignees(failed.root, new AbortController().signal)
  expect(failed.labels[0]!.textContent).toBe("Could not load assignee")
  setDirectory(async () => ({ users: [], ha_connected: true, ha_roster_verified: false }))
  const unverified = surface(["ha_missing"])
  await hydrateTaskAssignees(unverified.root, new AbortController().signal)
  expect(unverified.labels[0]!.textContent).toBe("Home Assistant assignee not verified")
  setDirectory(async () => ({ users: [{ id: "custom_a", name: "Alex" }, { id: "custom_b", name: " Alex " }] }))
  const grouped = surface(["custom_a", "custom_b", ""], true)
  await hydrateTaskAssignees(grouped.root, new AbortController().signal)
  expect(grouped.labels.map(label => label.textContent)).toEqual(["Alex (1)", " Alex  (2)", "Unassigned"])
})
