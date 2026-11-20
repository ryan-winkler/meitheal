import { expect, test } from "@playwright/test"
import { sameTaskLocator, taskDetailPath, ticketIdFromPath } from "../../apps/web/src/lib/task-page-url"

const id = "3f2a9c4e-0b7d-4e1a-9f00-1c2d3e4f5a6b"

test("ticket paths prefer the readable key and fall back to the task ID", () => {
  expect(taskDetailPath("MTH-4")).toBe("/tickets/MTH-4")
  expect(taskDetailPath({ id, ticket_key: "MTH-4" })).toBe("/tickets/MTH-4")
  expect(taskDetailPath({ id, ticket_key: "Q7XK2MPA-12" }, 9)).toBe("/tickets/Q7XK2MPA-12?comment=9")
  for (const ticket_key of [undefined, null, "", 4]) {
    expect(taskDetailPath({ id, ticket_key })).toBe(`/tickets/${id}`)
  }
  expect(taskDetailPath({ id: 42 })).toBe("/tickets/42")
  expect(ticketIdFromPath(taskDetailPath({ id, ticket_key: "MTH-4" }))).toBe("MTH-4")
})

test("drawer locators match the task ID exactly and its key in any case", () => {
  expect(sameTaskLocator(id, id, "MTH-4")).toBe(true)
  expect(sameTaskLocator("MTH-4", id, "MTH-4")).toBe(true)
  expect(sameTaskLocator("mth-4", id, "MTH-4")).toBe(true)
  expect(sameTaskLocator("q7xk2mpa-12", null, "Q7XK2MPA-12")).toBe(true)
  expect(sameTaskLocator(id.toUpperCase(), id, null)).toBe(false)
  expect(sameTaskLocator("MTH-5", id, "MTH-4")).toBe(false)
  expect(sameTaskLocator("MTH-4", id, null)).toBe(false)
  expect(sameTaskLocator("MTH-4", null, null)).toBe(false)
})
