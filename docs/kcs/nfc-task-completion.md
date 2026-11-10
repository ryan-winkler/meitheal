# Complete an assigned task with NFC

With the NFC feature enabled, assign a physical tag identifier using `PUT /api/tasks/{id}` with `nfc_tag_id`. Use a non-empty identifier of at most 255 characters, or `null` to remove the assignment. Assign each tag to one unarchived task.

Send `POST /api/nfc/complete` with JSON `{"tag_id":"your-tag-identifier"}`. API credentials need `tasks:write`; read-only tokens cannot complete a task. A unique assignment uses the ordinary task mutation path, including completion statistics and events. Repeating a scan of an already-complete task acknowledges it without another reward. An unknown tag returns 404. Duplicate assignments return 409 without choosing a task; remove the unwanted assignment and retry. Requests are limited to 4 KiB.

The local API fixture verifies scoped authority, unknown and duplicate assignments, clearing a tag and repeated completion. Native Home Assistant service routing and scanning a physical tag require separate environment checks. A successful API acknowledgement does not prove that a phone or reader has delivered a scan.
