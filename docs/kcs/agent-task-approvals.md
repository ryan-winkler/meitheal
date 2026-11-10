# Agent task approvals

Use the proposal scope when an automation should suggest a change for a person to review. In **Settings → Automation & AI → Agent Tokens**, issue a token with **Propose Task Changes** (`tasks:propose`). Add **Read Tasks** only if the client also needs to browse tasks. Direct task writes use their existing separate permission. A proposal token cannot approve its own work. For mandatory review, grant `tasks:propose` and only the read/transport scopes the client needs; omit `tasks:write`, `tasks:delete`. This is an operation permission boundary, not a restriction based on advisory per-task AI scope preferences. Claims and review windows are fixed; there is no automatic acceptance setting.

## Submit a proposal

Send JSON to `POST /api/tasks/{id}/handoff` with the scoped Meitheal bearer token. Use a task ID or a ticket key, and preserve the App's ingress prefix when using its browser address.

| Step | Request | Result |
| --- | --- | --- |
| Claim | `{"action":"claim"}` | Returns a unique `lease` and an expiry time in Unix milliseconds. The claim lasts five minutes. |
| Propose | `{"action":"propose","lease":"<lease>","summary":"Clarify the label","updates":{"title":"Check hallway light"}}` | Queues the change for 24 hours. Returns a proposal `hash` and `reviewUntil`. The task stays unchanged while the proposal is pending. |
| Release | `{"action":"release","lease":"<lease>"}` | Releases an active claim before submission. |

A proposal can contain a title, a description, or both. An empty description clears it. Each task can have one active claim or pending proposal. If the lease expires or an operation returns HTTP 409, read the task again and obtain a new claim when it is available. MCP clients also need `mcp:execute` when calling the generated `manageTaskHandoff` tool. A2A execution remains unavailable.

## Decide in Home Assistant

1. Open Meitheal through authenticated Home Assistant ingress as a current administrator. Authority is rechecked with Core for every decision.
2. Open **Settings → Automation & AI → Agent approvals → Open review queue**.
3. Expand a proposal and compare the current and proposed values.
4. Choose **Approve changes** to apply those fields or **Reject proposal** to dismiss it. The queue reports the result and the task activity records applied field changes.

If the relevant task text changed after submission, refresh the queue. The earlier proposal cannot overwrite those edits. You can reject it and ask the automation to submit a fresh proposal. An expired proposal drops out of the queue and no longer holds the task. Revoking a token stops new calls. Pending proposals remain available for an administrator's decision until they expire.

For transport discovery and token scopes, see [Agent protocol setup](agent-automation-guide.md).
