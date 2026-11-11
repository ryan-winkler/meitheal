---
type: "Runbook"
title: "Review agent proposals"
description: "Compare, accept and reject a saved task proposal through Home Assistant ingress."
---

# Review agent proposals

Open **Settings → Automation & AI → Open Review** through Home Assistant ingress with a current, active administrator account. Review checks the current Core role before displaying the queue; each decision checks it again. A token that proposes task changes cannot approve them. Standalone access and ordinary household members cannot open this administrator queue.

Each card shows the proposing agent, summary, expiry, and proposed title or description changes. **When proposed** is the value the agent started with; **Current** is the value read for this page; **Proposed** is the requested replacement. If the task has changed, acceptance is unavailable. You can reject the stale proposal without applying it, or refresh and review the latest values.

Accept or reject only after reading the displayed changes. The decision includes that displayed proposal's fingerprint. The page never fetches a newer fingerprint and silently substitutes it. A confirmed success stays visible on the card until you refresh. Acceptance updates the task; rejection leaves its values unchanged.

While a decision is pending, the card keeps its values visible and ignores repeated submissions. A conflict, expired proposal, permission failure or missing acknowledgement keeps the card and a visible explanation. Use **Refresh proposal** or **Refresh queue** to read the latest queue before another decision. If no acknowledgement arrived, the decision may already have been saved: refresh and check the task before retrying. Do not interpret a network failure as proof that nothing changed.

Expired proposals cannot be decided and disappear after refreshing. The queue shows up to 25 cards per page, with explicit previous and next links. Refresh and pagination remain within the Home Assistant ingress path.

If administrator verification is unavailable, restore the app's Home Assistant connection and refresh. If access was revoked while the page was open, the decision is denied and the queue must be opened again by a current administrator. A queue-loading failure shows a retry link rather than an empty-queue claim.
