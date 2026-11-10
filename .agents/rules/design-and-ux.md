# Design and UX Rules

---
trigger: always_on
---

When Considering UI, Ux and design factors, you have the folowing information and constraints:

We will go Page by page, auditing with @beautifulMentionand @beautifulMention to ensure everything works as intended and functions like a production ready app that we can publish to others. Main rules and considerations for each Page

-- Everything follows DDD and RICe and is properly Documented via KCS and DDD methodlogy
-- Everything is Astro Native/Firsrt
-- Everything is Designed Specifically for Home assistant and Home assistant supervisor (see @beautifulMention for more information
-- Everything Meets (at minimum) or exceeds our @beautifulMention
-- Everything is Optimised in terms of Shared Components, Modular code that can be reused and follows a professional and strategic design pattern
-- Assuming everything we do is going to be released publicly (no guessing, no dummy data, no hardcoded assumption
--- Treat the URL like API -- Must be human readable, presents well and not some random generated articfact

-- You must Consider how everything looks and Feels Being an app inside home assistant

-- you MUST update your context docs, tasks and implementation plans often and meticulously, so context, deferrals and TODOS are not lost

-- with /gsd use /clear to help with context drift as much as possibel and where relevant

## Development & Testing Environments

Use `/local-dev` for the full workflow. Quick reference:

| Tier | URL | Purpose |
|------|-----|---------|
| 🔧 Local Dev | `localhost:4321` (or `--port 4500`) | UI/CSS/JS changes — `npm run dev` in `apps/web/` |
| 🏠 HA Devcontainer | `localhost:7123` | Full HA Supervisor context — ingress, WebSocket, addon lifecycle. Per [HA app testing docs](https://developers.home-assistant.io/docs/apps/testing/) |
| 🌐 **Live Production** | `ha.internal:8123` | **Real system with real data**. Runs released Docker images. NOT a dev server. |

> ⚠️ `ha.internal` URLs below are for **verification of deployed releases only**. For development iterations, use Local Dev or HA Devcontainer.


We will cover the following (in order)

- Dashboard/Home — <http://ha.internal:8123/868b2fee_meitheal_hub>
- KanBan — <http://ha.internal:8123/api/hassio_ingress/nSNXnUWXfe2DcUzE_X_4wsGWAwTIUze7_WdXaSsXJwo/kanban>
- Table — <http://ha.internal:8123/api/hassio_ingress/nSNXnUWXfe2DcUzE_X_4wsGWAwTIUze7_WdXaSsXJwo/table>
- Today — <http://ha.internal:8123/api/hassio_ingress/nSNXnUWXfe2DcUzE_X_4wsGWAwTIUze7_WdXaSsXJwo/today>
- Upcoming — <http://ha.internal:8123/api/hassio_ingress/nSNXnUWXfe2DcUzE_X_4wsGWAwTIUze7_WdXaSsXJwo/upcoming>
- Calendar — <http://ha.internal:8123/api/hassio_ingress/nSNXnUWXfe2DcUzE_X_4wsGWAwTIUze7_WdXaSsXJwo/calendar>
- New Task Modal
- Settings — <http://ha.internal:8123/api/hassio_ingress/nSNXnUWXfe2DcUzE_X_4wsGWAwTIUze7_WdXaSsXJwo/settings>
- Edit Card/Ticket Modal
- Search/ Search Modal
- Board selection and settings

There may be other Areas, but these are definitely most, so pay attenton to them, and ensure we are accurate and all inclusive

---

Do not move onto new page until the first is complete, UNLESS scope or dependency counts on it and should be included (you can break this constraint if it makes sense)

You MUST use GSD and planning personas several times @beautifulMention @beautifulMention@beautifulMention @beautifulMention @beautifulMention (and others where relevant) before moving on or considering your work complete

## UI repair and review baseline

Consider the existing Tabler admin-template patterns before introducing a custom
component or dependency: https://tabler.io/admin-template. Check whether Tabler
is actually installed; reuse existing local primitives when they already solve
the problem. Audit changes against Gestalt grouping, Nielsen usability
heuristics, DRY and YAGNI. Controls and saved indicators must represent actual
supported behavior, including failure and unavailable states.
