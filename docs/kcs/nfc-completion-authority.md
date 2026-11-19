# NFC completion with limited credentials

An NFC scan uses the selected Board's completion authority to locate a uniquely assigned Task. The lookup returns only internal ID/status metadata. It does not grant Task reads, and assigned-only credentials can locate only their currently assigned Tasks. Other Boards and inaccessible placements remain unavailable.

Completion uses the ordinary Task update command and its current completion, assignment and placement checks. A credential with completion permission but no Task read permission receives exactly `{ "ok": true }` on success and retry. The response does not reveal the Task ID, title, status, or whether that scan was a retry. Current readable callers retain the existing Task response and `already_complete` acknowledgement.

An unknown tag returns 404; multiple eligible assignments return 409. A current Board or user completion restriction returns 403, including a scan of an already completed Task. Replaying a completed scan does not repeat completion effects. Removing the assignment from an assigned-only credential makes later scans unavailable.

Kanban's Area-filtered index and rendered cards use the same visible effective Area. A Task placed only in a Project appears under that Project's visible Area, while unfiled and inaccessible associations remain unfiled or unavailable. Physical historical placement remains intact.

Recurrence updates accept the existing parser's optional `RRULE:` prefix and ISO-formatted `UNTIL` dates. The 200-character bound and supported-frequency parsing remain enforced; clearing still stops successors. The creation form's existing input normalization is unchanged.

Source regression: `tests/e2e/ordinary-work-r52-nfc-addon.spec.ts` covers both storage encodings, real credential resolution and actual HTTP route handlers. Packaged Home Assistant verification remains a separate release gate.
