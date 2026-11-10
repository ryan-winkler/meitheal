---
type: Runbook
title: Local feedback queue
description: Submit, review, and share feedback from a Meitheal installation.
---

# Local feedback queue

Open Meitheal from Home Assistant, then choose **Settings → App & PWA → Report a problem or share feedback**. Choose a category and enter up to 4 KiB of plain text. You can opt in to include the app version and the Settings page category. Avoid credentials, addresses and other private details. The report, submitter ID and date stay in your installation. Meitheal displays a receipt after SQLite saves the report.

If a request fails, keep the form open and retry with the same category, text and context. If the first attempt was saved, the retry returns the original receipt. Changing the draft creates a new submission. The receipt remains valid while the report is in the queue.

For a suspected vulnerability, use the underlined **Report a security vulnerability privately** link below the feedback panel. [Security policy](../../SECURITY.md).

## Review a report

A verified Home Assistant administrator can open **Local feedback queue** in the same Settings card. Select a state and expand a report. The queue loads up to 50 reports at a time.

1. Claim an open report to move it to **In progress**.
2. Add a short disposition, then resolve or decline the report.
3. To share a report, enter a separate reviewed copy under **Prepare a reviewed export**. Preview the JSON and check the text and optional context before downloading it. The export includes the reviewed text, category and any context the submitter chose. The original text, disposition, user IDs and timestamps stay in the queue.
4. Use **Delete closed report** when the report and its receipt can be removed. The installation holds up to 500 reports or 4 MiB of reserved content and disposition space. Open reports are preserved when the queue is full.

If SQLite remains busy, retry shortly with the same submission. If the queue is full, remove closed reports before accepting new ones. The report form has no attachments or raw diagnostics.

## Access and backups

Feedback requires Supervisor 2026.10.4 or later and a verified Home Assistant ingress user. The queue and its review actions require a verified administrator. Feedback responses bypass the service worker cache and report contents stay out of search, MCP tools and automation exports. The API checks the same-origin request marker on writes and limits the JSON request to 8 KiB before decoding it.

The raw SQLite download in **Settings → App & PWA** is available to verified Home Assistant administrators. It contains private household data and feedback, so keep it private. Use Home Assistant's cold app backup for a recoverable database snapshot. A standalone operator can back up SQLite through the host filesystem, with Meitheal stopped and any SQLite sidecar files kept together. [Backup and restore](home-assistant-backup-and-restore.md).

## Verification

The app applies its migrations at startup. For a local checkout, run `pnpm --filter @meitheal/web db:migrate` against the configured SQLite database before using the queue.

Run `pnpm --filter @meitheal/tests test e2e/feedback.spec.ts` for SQLite scope, retry, limits and review checks. To exercise the built routes and Settings controls, run the web build and then `MEITHEAL_TEST_BROWSER=1 pnpm --filter @meitheal/tests test e2e/feedback-ingress.spec.ts`. The browser fixture uses disposable SQLite and synthetic ingress identities. Check that the form guidance, queue controls, and security reporting link are legible for members and administrators in both themes. In a Home Assistant devcontainer, confirm member and administrator permissions through the actual Supervisor ingress, including retry after a restart.
