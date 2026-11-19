import { expect, test } from "@playwright/test"
import { projectPublicTaskFields } from "../../apps/web/src/domains/tasks/task-projection"

test("shared transport projection retains rich task fields and excludes private current or future columns", () => {
  const row = {
    id: "task-1", title: "Shopping", task_kind: "shopping_item", board_id: "opaque-board", ticket_key: "WORK-1",
    custom_fields: { items: [{ name: "Milk", qty: 2 }] }, checklists: [{ text: "Remember bags", done: false }],
    capture_attempt_digest: "private-capture", operation_owner: "private-owner", operation_digest: "private-operation",
    client_idempotency_key: "private-caller-key", idempotency_key: "private-internal-key",
    agent_scratchpad: "private-notes", proposal_json: "private-review", proposal_hash: "private-lease",
    unknown_future_private_column: "private-future",
  }
  expect(projectPublicTaskFields(row)).toEqual({
    id: "task-1", title: "Shopping", task_kind: "shopping_item", board_id: "opaque-board", ticket_key: "WORK-1",
    custom_fields: row.custom_fields, checklists: row.checklists,
  })
  expect(row).toHaveProperty("capture_attempt_digest", "private-capture")
})
