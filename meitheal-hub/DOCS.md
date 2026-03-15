# Meitheal Hub Add-on Docs

## Installation

### From HA Add-on Store (after publishing)

1. Add the Meitheal repository to Home Assistant add-on repositories.
2. Install the `Meitheal Hub` add-on.
3. Start the add-on.
4. Open Web UI via ingress.

### Self-Install on Your HA Green (pre-publishing)

1. Open Home Assistant → **Settings** → **Add-ons** → **Add-on Store**.
2. Click **⋮** (top-right) → **Repositories**.
3. Add: `https://github.com/Coolock-Village/meitheal`
4. Close the dialog, then search for **Meitheal Hub**.
5. Click **Install** → **Start** → **Open Web UI**.

> **Rapid development mode:** After pushing new images to Docker Hub, go to the add-on page → **⋮** → **Reload** to pick up new versions. Then click **Update** + **Restart** to get the latest build.

### Local Testing (no HA required)

```bash
# Build from repo root
podman build --build-arg BUILD_FROM="ghcr.io/home-assistant/amd64-base:3.23" \
  -f meitheal-hub/Dockerfile -t local/meitheal .

# Run standalone (no Supervisor)
podman run --rm -p 3333:3000 -v /tmp/meitheal-data:/data \
  local/meitheal /run-local.sh

# Verify
curl http://localhost:3333/api/health
```

## Configuration

- `log_level`: `debug|info|warn|error`
- `log_categories`: log categories to emit
- `log_redaction`: redact tokens/PII
- `audit_enabled`: emit audit log records
- `loki_url`: Loki push endpoint for observability pipeline

## Runtime Notes

- Uses SQLite at `/data/meitheal.db` by default.
- Runs DB migrations on startup.
- Uses `SUPERVISOR_TOKEN` for Home Assistant API service calls when available.
- Health endpoint: `GET /api/health`.

## Calendar Sync

Meitheal includes bidirectional calendar sync with Home Assistant calendar entities.

### How It Works

When running as an HA addon with `homeassistant_api: true`, Meitheal:

1. **Detects** your HA calendar entities automatically via WebSocket subscription
2. **Imports** calendar events (past 7 days → next 30 days) as Meitheal tasks
3. **Deduplicates** via a `calendar_confirmations` table — re-syncing never creates duplicate tasks
4. **Pushes back** task due dates as HA calendar events (when write-back is enabled)

### Calendar Settings

Configure in **Settings → Integrations → Calendar Sync**:

| Setting         | Description                                                        |
| --------------- | ------------------------------------------------------------------ |
| Calendar Entity | The HA calendar entity to sync with (e.g. `calendar.family`)      |
| CalDAV URL      | Optional direct CalDAV sync for non-HA calendars (Nextcloud, etc.) |
| Write-back      | Push task due dates to HA calendar as events                       |

### API Endpoints

- `GET /api/ha/calendars` — List detected calendar entities and sync status
- `GET /api/ha/calendars?entity_id=X&start=Y&end=Z` — Get events for a specific calendar
- `POST /api/ha/calendars` — Trigger manual sync

### Calendar Page

The `/calendar` page renders a monthly grid showing tasks by due date. Click any day to filter tasks for that date. The calendar respects your configured week start day (Monday, Sunday, or Saturday).

## Voice & Assist Integration

Meitheal integrates with Home Assistant's Assist (voice control) and LLM-based conversation agents (Google Generative AI, OpenAI, Ollama). This lets you manage tasks by voice or through any HA conversation agent.

### Quick Setup (2 steps)

#### Step 1: Confirm the integration is loaded

After installing the addon, HA should auto-discover the Meitheal integration. Check:

- **Settings → Devices & Services** — "Meitheal" should appear
- If not, click **+ Add Integration** → search "Meitheal" → Submit

#### Step 2: Enable Meitheal in your conversation agent

1. Go to **Settings → Voice Assistants**
2. Click your conversation agent (e.g. "Gemini")
3. Click **Configure** (or the gear icon)
4. Under **LLM APIs**, select **"Meitheal Tasks"**
5. Click **Submit**

You should also expose the Meitheal todo entity to Assist:

1. Go to **Settings → Voice Assistants → Expose** tab
2. Find **todo.meitheal_tasks** and toggle it **ON**

### Example Voice Commands

Once configured, you can say things like:

| Command | What Happens |
| --------- | ------------- |
| "What are my tasks?" | Lists active tasks via search |
| "Add buy groceries to my tasks" | Creates a new task |
| "Mark buy groceries as done" | Completes the task by title |
| "What's overdue?" | Lists all overdue tasks |
| "What's on my plate today?" | Shows today's tasks + overdue |
| "How many tasks do I have?" | Returns task summary counts |
| "Set priority of task X to urgent" | Updates task priority |

### Available LLM Tools

When "Meitheal Tasks" is selected as an LLM API, these tools are available to the conversation agent:

| Tool | Description |
| ------ | ------------ |
| `meitheal_search_tasks` | Search by keyword, status, or priority |
| `meitheal_get_task` | Get full details for a specific task |
| `meitheal_create_task` | Create a new task |
| `meitheal_complete_task` | Mark a task as done (by ID or title) |
| `meitheal_update_task` | Update priority, due date, status, or description |
| `meitheal_get_overdue` | List all overdue tasks |
| `meitheal_get_todays_tasks` | Tasks due today + overdue |
| `meitheal_task_summary` | Active, overdue, done, and total counts |

### Built-in Assist API (no LLM required)

Even without an LLM agent, the basic **Assist API** supports:

- **"Add X to Meitheal Tasks"** → uses `HassListAddItem` intent
- **"Complete X in Meitheal Tasks"** → uses `HassListCompleteItem` intent

This works through the `todo.meitheal_tasks` entity when it's exposed to Assist.

### Troubleshooting

| Issue                    | Solution                                                            |
| ------------------------ | ------------------------------------------------------------------- |
| "I cannot find meitheal" | Expose the entity (Step 2 above) and select Meitheal Tasks LLM API |
| LLM API not in list      | Check addon logs for "Registered Meitheal LLM API" message         |
| Integration not found    | Restart the addon — it auto-discovers on each boot                  |
| Tasks not syncing        | Call `meitheal.sync_todo` service or restart addon                  |

## Security

### AppArmor

Meitheal Hub ships with a restrictive AppArmor profile (`apparmor.txt`) that:

- **Allows** TCP/UDP network access for the Node.js web server
- **Allows** read/write to `/data/` (SQLite persistence) and `/tmp/`
- **Denies** write access to all system paths (`/bin/`, `/boot/`, `/sys/`, etc.)
- **Denies** shell access (`/bin/sh`, `/bin/dash`)
- **Denies** raw/packet sockets, mount operations, and proc/sys writes
- Runs with minimal capabilities: `chown`, `dac_override`, `setuid`, `setgid`, `net_bind_service`

The Supervisor enforces this profile automatically when `apparmor: true` is set in `config.yaml`.

### Ingress Authentication

When accessed through the HA sidebar (ingress), the Supervisor validates the user's session and injects identity headers:

| Header | Purpose |
| ----------------- | ------------------------------------------------- |
| `X-Ingress-Path` | The ingress proxy path prefix |
| `hassio_token` | Session validation token |
| `X-Hass-User-Id` | Authenticated HA user ID |
| `X-Hass-Is-Admin` | Whether the user is a HA admin (`true`/`false`) |

Meitheal validates these headers on all API routes and rejects requests missing required headers with HTTP 401.

### Auth API

With `auth_api: true`, Meitheal can validate user credentials against the Home Assistant authentication backend via the Supervisor API. This avoids storing separate credentials.

### Additional Protections

- **CSRF**: Origin/referer validation on mutating requests
- **Rate limiting**: Per-IP rate limiting (120 req/min) with `X-Forwarded-For` support for ingress proxy
- **Security headers**: X-Content-Type-Options, CSP, Referrer-Policy, Permissions-Policy
- **Container isolation**: Runs with Docker namespace isolation + AppArmor profile
- **tmpfs**: `/tmp` mounted as tmpfs (ephemeral, no disk persistence)
- **Panel admin**: Sidebar panel restricted to HA admin users

## Publishing Requirements

- `image` is configured in `config.yaml` and uses the `{arch}` suffix.
- Images are published to Docker Hub under `coolockvillage/meitheal-{arch}`.
- Version tags and published container tags should match add-on `version`.
- Root `repository.yaml` must stay present for repository publishing.
- `apparmor.txt` must be present alongside `config.yaml`.
- `translations/en.yaml` provides English option descriptions.
- `icon.png` (128×128) and `logo.png` (250×100) present in addon folder.
