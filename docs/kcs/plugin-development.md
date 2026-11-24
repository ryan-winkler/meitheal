---
type: "Guide"
title: "Plugin Development Guide"
description: "Build, package, secure, and test sandboxed Meitheal plugins and external connectors."
---

# Plugin Development Guide

> **NOTE:** This guide documents the Meitheal plugin contract defined in [ADR 0028](../decisions/0028-plugin-bounded-context-and-sandbox.md). Use this reference to design, build, and review Meitheal extensions and connectors.

Meitheal plugins extend the household workspace with custom views, task automations, and external service connectors. Unlike unsandboxed plugin systems, every Meitheal plugin runs inside strict browser isolation with enforced permissions.

## 1. Plugins and Connected Services

Meitheal separates core platform infrastructure from modular plugins:

| Area | Settings Path | Purpose | Examples |
| --- | --- | --- | --- |
| **Connected Services** | **Settings -> Connected Services** (`#connections-settings`) | Core platform services that need direct server access | Home Assistant, Calendar sync, `todo.meitheal_tasks`, Grocy, n8n, Webhooks |
| **Plugins** | **Settings -> Plugins** (`#plugins-settings`) | Modular UI extensions and third-party external connectors | GitHub Issues, Gitea Issues, custom ZIP extensions, AI-built plugins |

Meitheal ships production external connectors (`github-issues`, `gitea-issues`) built in. Example development extensions (`examples/plugins/yesterday-carryover` and `examples/plugins/focus-pulse`) live only as standalone reference apps in this repository and are not pre-installed in the runtime app.

Meitheal supports two plugin types:

- **`extension`**: Adds header buttons, a side panel, toasts, or task event hooks inside the workspace.
- **`connector`**: Connects an external issue tracker or service through the Meitheal HTTP gateway and maps external items into Meitheal tasks.

## 2. Quick Start

Follow these steps to create and package a working Meitheal plugin.

### Step 1: Create the plugin folder

Create a new folder named `carryover-helper` with four files:

```text
carryover-helper/
├── manifest.json
├── plugin.js
├── index.html
└── icon.svg
```

### Step 2: Create `manifest.json`

Write `manifest.json` in the root of the plugin folder:

```json
{
  "id": "carryover-helper",
  "name": "Yesterday Carryover",
  "version": "1.0.0",
  "minMeithealVersion": "0.0.2",
  "type": "extension",
  "description": "Review unfinished tasks from yesterday and move them to Today.",
  "author": "Your Name",
  "license": "MIT",
  "icon": "icon.svg",
  "entry": "plugin.js",
  "iFrame": "index.html",
  "sidePanel": true,
  "permissions": [
    "tasks:read",
    "tasks:write",
    "storage:local",
    "ui:header-button",
    "ui:side-panel",
    "ui:toast"
  ],
  "hooks": [
    "task.completed"
  ],
  "allowedHosts": [],
  "dataSharing": {
    "outbound": false,
    "destinations": [],
    "dataTypes": [],
    "summary": "This plugin runs locally and does not send data outside Meitheal."
  }
}
```

### Step 3: Write `plugin.js`

Write the plugin logic in `plugin.js`. This file runs inside a hidden opaque-origin `<iframe sandbox="allow-scripts">` (`origin: null`, `connect-src 'none'`). It has zero access to parent DOM elements, cookies, `localStorage`, or direct `/api/*` requests.

```javascript
MeithealPlugin.onInit(async (api) => {
  await api.registerHeaderButton({
    id: "open-carryover",
    label: "Carryover",
    icon: "history",
    onClick: () => api.openSidePanel()
  })

  api.registerHook("task.completed", async (event) => {
    const count = Number((await api.storage.get("completedToday")) || 0) + 1
    await api.storage.set("completedToday", count)
  })
})

MeithealPlugin.onMessage(async (message, api) => {
  if (message.type === "LIST_OVERDUE") {
    const tasks = await api.getTasks({ status: "todo", overdue: true })
    return { tasks }
  }

  if (message.type === "MOVE_TO_TODAY" && typeof message.taskId === "string") {
    const today = new Date().toISOString().slice(0, 10)
    await api.updateTask(message.taskId, { dueDate: today })
    await api.showToast({
      type: "success",
      message: "Task moved to Today."
    })
    return { ok: true }
  }

  return { ok: false }
})
```

### Step 4: Write `index.html`

Write the side-panel interface in `index.html`. Meitheal injects theme variables automatically.

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Yesterday Carryover</title>
  <style>
    body {
      margin: 0;
      padding: 1rem;
      font-family: var(--font-sans, system-ui, sans-serif);
      background: var(--bg-surface, #101210);
      color: var(--text-primary, #f4f7f5);
    }
    .item {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 0.75rem;
      padding: 0.75rem;
      margin-bottom: 0.5rem;
      border: 1px solid var(--border, #28332c);
      border-radius: var(--radius, 8px);
      background: var(--bg-elevated, #171c19);
    }
    button {
      padding: 0.4rem 0.75rem;
      border: 1px solid var(--accent, #69e3b2);
      border-radius: var(--radius, 6px);
      background: transparent;
      color: var(--accent, #69e3b2);
      cursor: pointer;
    }
  </style>
</head>
<body>
  <h2>Yesterday Carryover</h2>
  <div id="list">Loading tasks...</div>
  <script>
    const listEl = document.getElementById("list")

    async function loadTasks() {
      const response = await window.MeithealUI.send({ type: "LIST_OVERDUE" })
      listEl.textContent = ""

      if (!response.tasks || response.tasks.length === 0) {
        listEl.textContent = "No overdue tasks remain."
        return
      }

      for (const task of response.tasks) {
        const row = document.createElement("div")
        row.className = "item"

        const title = document.createElement("span")
        title.textContent = task.title

        const button = document.createElement("button")
        button.type = "button"
        button.textContent = "Move to Today"
        button.addEventListener("click", async () => {
          await window.MeithealUI.send({ type: "MOVE_TO_TODAY", taskId: task.id })
          await loadTasks()
        })

        row.append(title, button)
        listEl.append(row)
      }
    }

    loadTasks()
  </script>
</body>
</html>
```

### Step 5: Add `icon.svg`

Create a clean `24x24` outline SVG icon with a `1.75` stroke width to match Tabler icons:

```xml
<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"
  fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
  <path d="M12 8l0 4l2 2" />
  <path d="M3.05 11a9 9 0 1 1 .5 4m-.5 5v-5h5" />
</svg>
```

### Step 6: Package and install the ZIP archive

Use the zero-dependency packager CLI from the repository root to build a validated ZIP archive:

```bash
node scripts/pack-plugin.mjs examples/plugins/yesterday-carryover
```

The packager reads `manifest.json`, rejects symbolic links and unsafe paths, packs only declared plugin files, and prints the output `.zip` path and SHA-256 digest.

1. Run `node scripts/pack-plugin.mjs <your-plugin-dir>` (or pass `--out <file.zip>`).
2. Open **Settings -> Plugins** in Meitheal as an administrator.
3. Select **Choose Plugin File** and upload the generated `.zip` file.
4. Review the requested permissions and data-sharing summary inside **Details**.
5. Enable the plugin switch and check **Plugin Health** to confirm green **Operational** and **Compliant (5/5)** status.

## 2a. Reference Plugins

Working reference extensions live in `examples/plugins/` so you can copy and modify them without cluttering the live app:

- `examples/plugins/yesterday-carryover/` — Side panel that lists overdue or unscheduled tasks and pulls them into Today.
- `examples/plugins/focus-pulse/` — Side panel showing open/completed counts and saving a daily household intention in isolated plugin storage.

Package either reference app with `node scripts/pack-plugin.mjs examples/plugins/<folder>` and upload the ZIP in **Settings -> Plugins**.

## 3. Package Rules and Limits

Meitheal validates every uploaded ZIP archive before saving any file.

| Rule | Limit or Requirement |
| --- | --- |
| Maximum compressed ZIP size | `2 MB` |
| Maximum uncompressed total size | `8 MB` |
| Maximum file count | `50` files |
| Maximum compression ratio | `20:1` (zip-bomb protection) |
| Allowed file extensions | `.json`, `.js`, `.mjs`, `.html`, `.css`, `.svg`, `.png`, `.webp`, `.txt`, `.md` |
| Forbidden paths | `..` traversal segments, absolute paths, symbolic links, hidden `.git` files |
| Forbidden files | Binaries, shell scripts, `.wasm` executables, `.exe`, `.sh`, `.node` |

> **CAUTION:** Do not put `<script>` elements, `onload` attributes, `<foreignObject>` tags, or external `href` links in `icon.svg`. Meitheal removes unsafe SVG content or rejects the archive during upload.

## 4. Manifest Reference (`manifest.json`)

Every plugin archive must include a valid UTF-8 `manifest.json` file.

### Top-level fields

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `id` | `string` | Yes | Unique lowercase slug (`^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$`). |
| `name` | `string` | Yes | Human-readable display name (3 to 60 characters). |
| `version` | `string` | Yes | Semantic version (`MAJOR.MINOR.PATCH`, for example `1.0.0`). |
| `minMeithealVersion` | `string` | Yes | Minimum Meitheal version required (for example `0.0.2`). |
| `type` | `string` | Yes | `"extension"` or `"connector"`. |
| `description` | `string` | Yes | Plain description of plugin behavior (maximum 200 characters). |
| `author` | `string` | Yes | Author or maintainer name. |
| `license` | `string` | Yes | SPDX license identifier (for example `"MIT"` or `"AGPL-3.0-only"`). |
| `icon` | `string` | No | Relative path to an `.svg` or `.png` icon inside the archive. |
| `entry` | `string` | No | Relative path to the Web Worker script (for example `"plugin.js"`). |
| `iFrame` | `string` | No | Relative path to the sandboxed UI HTML file (for example `"index.html"`). |
| `sidePanel` | `boolean` | No | Set to `true` to register a workspace side panel for `iFrame`. |
| `permissions` | `string[]` | Yes | Exact list of capabilities requested by the plugin. |
| `hooks` | `string[]` | No | List of Meitheal events the plugin listens to. |
| `allowedHosts` | `string[]` | Yes | Exact external hostnames allowed for outbound HTTP requests. Use `[]` for local-only plugins. |
| `dataSharing` | `object` | Yes | Mandatory plain-language disclosure of external data transmission. |
| `connector` | `object` | No | Required when `type` is `"connector"`. Defines external tracker settings and sync options. |

### Permissions reference

Meitheal enforces every permission at runtime. If a plugin calls an API method without its matching permission, Meitheal rejects the call with `PERMISSION_DENIED`.

| Permission | Mapped Scope | Capability Granted |
| --- | --- | --- |
| `tasks:read` | `tasks:read` | Read tasks on boards visible to the active user. |
| `tasks:write` | `tasks:write` | Create, update, and complete tasks on boards editable by the active user. |
| `boards:read` | `boards:read` | List boards accessible to the active user. |
| `storage:local` | Plugin isolated namespace | Read and write key-value data for this plugin only. |
| `ui:header-button` | UI slot | Register up to two buttons in the workspace header. |
| `ui:side-panel` | UI slot | Open and render the plugin `iFrame` inside the workspace side panel. |
| `ui:toast` | UI slot | Display status toasts through Meitheal's unified toast region. |
| `http:outbound` | HTTP gateway | Send requests through `POST /api/plugins/:id/http` to `allowedHosts`. |
| `secrets:use` | Server secret template | Reference admin-configured secrets with `{{secret:key}}` in gateway headers. |

### Hooks reference

Declare every subscribed hook in `manifest.json`:

- `task.created` — Runs after a task is saved.
- `task.updated` — Runs after a task title, status, priority, or date changes.
- `task.completed` — Runs after a task moves to `done`.
- `view.changed` — Runs when the user switches views (for example `today`, `kanban`, `calendar`).
- `board.changed` — Runs when the user switches the active board.

### Mandatory `dataSharing` schema

Meitheal validates `dataSharing` against `allowedHosts` during upload.

```json
"allowedHosts": ["api.github.com"],
"dataSharing": {
  "outbound": true,
  "destinations": [
    {
      "host": "api.github.com",
      "purpose": "Fetch assigned GitHub issues and post completion comments."
    }
  ],
  "dataTypes": ["task_title", "task_status", "issue_number"],
  "summary": "Sends selected task titles and completion status to GitHub."
}
```

Validation rules for `dataSharing`:

1. If `allowedHosts` contains one or more hosts, `dataSharing.outbound` must be `true`.
2. Every host in `allowedHosts` must appear in `dataSharing.destinations`.
3. If a connector supports a self-hosted server, set `host` to `"$userServer"`. The administrator must enter and approve the server URL in plugin settings before requests succeed.

## 5. Security and Sandbox Architecture

> **WARNING:** Never copy credentials into `plugin.js`, `index.html`, or plugin storage. Always store API tokens as write-only secrets and inject them through `{{secret:key}}` headers on the server.

Meitheal protects household data and Home Assistant access with five defense layers:

### Layer 1: Opaque-origin logic frame (`plugin.js`)

Meitheal loads `plugin.js` inside a hidden `<iframe sandbox="allow-scripts">` with `srcdoc` and `connect-src 'none'`. Its origin is `null` (opaque), so it cannot access the parent DOM, browser cookies, `localStorage`, `IndexedDB`, or `/api/*` endpoints directly. All host calls cross a per-mount token-verified `postMessage` JSON-RPC bridge.

### Layer 2: Opaque-origin UI iframe (`index.html`)

Meitheal renders `index.html` inside `<iframe sandbox="allow-scripts allow-forms">` using `srcdoc`.

- Meitheal never enables `allow-same-origin` or `allow-top-navigation`.
- Meitheal strips plugin-supplied CSP meta tags and injects a strict `<meta http-equiv="Content-Security-Policy">` tag that blocks external scripts and direct network requests.
- The iframe communicates only with its own `plugin.js` runner through `window.MeithealUI.send(message)`.

### Layer 3: No arbitrary server execution

Meitheal does not execute plugin code on the Node.js server. Plugins cannot spawn child processes, read `/data/meitheal.db`, or read `SUPERVISOR_TOKEN`.

### Layer 4: SSRF-hardened HTTP gateway

Plugins that declare `http:outbound` send requests through `POST /api/plugins/:id/http`. Before making a network call, the Meitheal server verifies:

1. The plugin is enabled and **Safe Mode** is off.
2. The target host matches `allowedHosts` (or the admin-approved `$userServer`).
3. The protocol is HTTPS (HTTP is rejected for external hosts).
4. The resolved IP address is not loopback (`127.0.0.0/8`, `::1`), link-local (`169.254.0.0/16`, `fe80::/10`), or cloud metadata (`169.254.169.254`).
5. The hostname is not an internal Home Assistant host (`supervisor` or `hassio`).
6. Private RFC 1918 addresses (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`) stay blocked by default. An administrator must explicitly approve a local `$userServer` URL to allow them.

### Layer 5: Write-only secrets and Safe Mode

- Administrators enter API keys in **Settings -> Plugins -> Details -> Secrets**.
- Meitheal stores secrets in the `plugin_secrets` table and never returns raw values in API responses, logs, or JSON/CSV exports.
- When `plugin.js` sends a header such as `Authorization: Bearer {{secret:github_token}}`, the server replaces `{{secret:github_token}}` right before sending the request to the allowed host.
- If a plugin misbehaves, toggle **Safe Mode** in **Settings -> Plugins**. Safe Mode stops all plugin workers and iframes immediately while keeping settings intact.

### Home Assistant Ingress safety

Meitheal often runs behind a Home Assistant Ingress subpath (for example `/api/hassio_ingress/<token>/`).

- Plugins must never construct direct `fetch("/api/...")` calls.
- Plugins must always use `api.*` methods provided by `MeithealPlugin`.
- The Meitheal host handles Ingress path prefixing, CSRF tokens, and authentication headers automatically.

## 6. Plugin API Reference (`MeithealPlugin`)

### Tasks and boards

```typescript
interface TaskFilter {
  boardId?: string
  status?: "backlog" | "todo" | "in_progress" | "done"
  overdue?: boolean
  limit?: number
}

await api.getTasks(filter?: TaskFilter): Promise<PluginTask[]>
await api.getTask(taskId: string): Promise<PluginTask | null>
await api.createTask(input: {
  title: string
  description?: string
  boardId?: string
  priority?: "low" | "medium" | "high" | "critical"
  dueDate?: string
  externalRef?: { providerId: string; externalId: string; url?: string }
}): Promise<PluginTask>
await api.updateTask(taskId: string, patch: {
  title?: string
  description?: string
  status?: "backlog" | "todo" | "in_progress" | "done"
  priority?: "low" | "medium" | "high" | "critical"
  dueDate?: string | null
}): Promise<PluginTask>
await api.completeTask(taskId: string): Promise<{ ok: true }>
await api.getBoards(): Promise<Array<{ id: string; name: string; visibility: string }>>
```

### User interface slots

```typescript
await api.registerHeaderButton({
  id: string,
  label: string,
  icon: string, // Canonical Tabler outline icon name (for example "history", "plug")
  onClick: () => void
}): Promise<void>

await api.openSidePanel(): Promise<void>
await api.closeSidePanel(): Promise<void>

await api.showToast({
  type: "info" | "success" | "warning" | "error",
  message: string,
  description?: string
}): Promise<void>
```

### Isolated plugin storage

Each plugin gets an isolated key-value store scoped by `pluginId` (maximum `256 KB` per plugin).

```typescript
await api.storage.get<T = unknown>(key: string): Promise<T | null>
await api.storage.set(key: string, value: unknown): Promise<void>
await api.storage.remove(key: string): Promise<void>
```

### Outbound HTTP requests and secrets

Requires `http:outbound` (and `secrets:use` when using `{{secret:...}}` templates).

```typescript
const response = await api.http.request({
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  url: "https://api.github.com/issues?filter=assigned",
  headers: {
    "Accept": "application/vnd.github+json",
    "Authorization": "Bearer {{secret:github_token}}"
  },
  body?: unknown,
  timeoutMs?: number // Default 8000, maximum 15000
})
// Returns: { status: number, ok: boolean, headers: Record<string, string>, json: unknown, text: string }
```

## 7. Building an External Connector (`type: "connector"`)

Use `type: "connector"` to connect Meitheal to external tools such as GitHub Issues, Gitea Issues, Linear, or Nextcloud Deck.

### Step 1: Declare `connector` metadata in `manifest.json`

```json
{
  "id": "gitea-issues",
  "name": "Gitea Issues",
  "version": "1.0.0",
  "minMeithealVersion": "0.0.2",
  "type": "connector",
  "description": "Import assigned issues from your self-hosted Gitea server into a Meitheal board.",
  "author": "Meitheal Community",
  "license": "MIT",
  "icon": "icon.svg",
  "entry": "plugin.js",
  "permissions": [
    "tasks:read",
    "tasks:write",
    "boards:read",
    "storage:local",
    "http:outbound",
    "secrets:use",
    "ui:toast"
  ],
  "allowedHosts": ["$userServer"],
  "dataSharing": {
    "outbound": true,
    "destinations": [
      {
        "host": "$userServer",
        "purpose": "Read assigned issues from your configured Gitea server."
      }
    ],
    "dataTypes": ["issue_title", "issue_number", "completion_state"],
    "summary": "Communicates only with the Gitea URL configured by your administrator."
  },
  "connector": {
    "supportsWriteBack": false,
    "defaultPollMinutes": 15,
    "configFields": [
      {
        "key": "serverUrl",
        "label": "Gitea Server URL",
        "type": "url",
        "required": true,
        "bindUserServer": true,
        "help": "Enter the base HTTPS URL of your Gitea instance."
      },
      {
        "key": "repository",
        "label": "Repository (owner/name)",
        "type": "text",
        "required": true,
        "help": "Enter the repository slug to sync."
      },
      {
        "key": "apiToken",
        "label": "Personal Access Token",
        "type": "secret",
        "required": true,
        "secretKey": "gitea_token",
        "help": "Stored write-only on the server. Never exposed to browser scripts."
      }
    ]
  }
}
```

### Step 2: Register the connector in `plugin.js`

```javascript
MeithealPlugin.registerConnector({
  async testConnection(config, api) {
    const base = config.serverUrl.replace(/\/$/, "")
    const res = await api.http.request({
      method: "GET",
      url: `${base}/api/v1/user`,
      headers: {
        "Authorization": "token {{secret:gitea_token}}"
      }
    })
    return {
      ok: res.ok,
      message: res.ok ? "Connected to Gitea." : `Gitea returned HTTP ${res.status}.`
    }
  },

  async fetchItems(config, api) {
    const base = config.serverUrl.replace(/\/$/, "")
    const res = await api.http.request({
      method: "GET",
      url: `${base}/api/v1/repos/${config.repository}/issues?state=open&limit=50`,
      headers: {
        "Authorization": "token {{secret:gitea_token}}"
      }
    })

    if (!res.ok || !Array.isArray(res.json)) {
      throw new Error(`Failed to load issues (HTTP ${res.status}).`)
    }

    return res.json.map((issue) => ({
      externalId: `${config.repository}#${issue.number}`,
      title: `[#${issue.number}] ${issue.title}`,
      description: issue.body || "",
      url: issue.html_url,
      dueDate: issue.due_date ? issue.due_date.slice(0, 10) : undefined
    }))
  }
})
```

Meitheal maps each returned item using `externalId` as an idempotency key so repeated sync runs do not create duplicate tasks.

## 8. Styling with Tabler and Meitheal Themes

Meitheal injects active theme tokens into every sandboxed `index.html` iframe. Use these CSS custom properties so your plugin matches **Emerald Isle**, **Knight Rider**, **Light**, and **Match Home Assistant theme** automatically:

| CSS Variable | Purpose |
| --- | --- |
| `--bg-surface` | Main panel background |
| `--bg-elevated` | Card and row background |
| `--text-primary` | Primary body and heading text |
| `--text-muted` | Secondary captions and metadata |
| `--border` | Subtle hairline borders |
| `--accent` | Active household accent color |
| `--success`, `--warning`, `--danger`, `--info` | Semantic status colors |
| `--radius` | Standard corner radius |
| `--font-sans` | Meitheal interface font family |

Follow these interface rules:

- Always build DOM elements with `document.createElement()` and `textContent`. Do not pass untrusted strings into `innerHTML`.
- Keep interactive touch targets at least `44x44px` on mobile screens.
- Use Tabler `1.75px` outline icons for visual consistency with Meitheal.

## 9. Verification Checklist

Run through these checks before sharing a plugin archive:

1. Validate `manifest.json` against the required fields and semver format.
2. Confirm every host in `allowedHosts` is listed in `dataSharing.destinations`.
3. Confirm the ZIP archive is under `2 MB` compressed and contains no hidden files or symbolic links.
4. Test the plugin in both dark (**Emerald Isle**) and light (**Light**) themes.
5. Test the plugin behind Home Assistant Ingress to confirm no hardcoded `/` URLs fail.
6. Toggle **Safe Mode** on and off to verify clean teardown with no duplicate buttons or errors.
7. Verify that uninstalling the plugin removes its buttons, side panel, storage, and secrets cleanly.

## 9a. Plugin Health and Elephant-Goldfish Compliance

Open **Settings -> Plugins -> Plugin Health** to inspect the operational state and security compliance of every active plugin.

Meitheal evaluates each plugin against five Elephant-Goldfish Model (EGM) checks:

| Check | EGM Axis | What Meitheal Verifies |
| --- | --- | --- |
| **Opaque-Origin Sandbox** | Goldfish (Stateless) | Execution stays inside opaque-origin frames (`origin: null`, `connect-src 'none'`) without `allow-same-origin`. |
| **Permission & Re-Consent** | Elephant (Stateful) | Upgraded packages that add permissions or hosts stay blocked until an administrator approves them. |
| **Outbound Network & SSRF** | Goldfish + Elephant | `allowedHosts` matches `dataSharing.destinations`, requires `http:outbound`, and requires admin approval for `$userServer`. |
| **Write-Only Secret Hygiene** | Elephant (Stateful) | Required connector secrets are configured write-only in `plugin_secrets` and scrubbed from SQLite backups. |
| **Package Integrity & Provenance** | Elephant (Stateful) | Valid 64-character SHA-256 package digest and explicit review warning on uploaded plugins that send outbound traffic. |

Status badges use both color and text labels:

- **Green (`Operational` / `Compliant (5/5)`)**: Active and passing all operational and EGM checks.
- **Amber (`Paused (Safe Mode)` / `Needs Configuration` / `Review`)**: Active or enabled, but requires admin action or destination review.
- **Red (`Blocked (Re-Consent)` / `Runtime Error` / `Non-Compliant`)**: Execution blocked or failed; follow the inline remediation message.

## 10. Build One With AI

You can create a custom plugin directly from **Settings -> Plugins -> Install Plugin -> Build one with AI**:

1. **Step 1 — Describe your idea**: Enter what the plugin should do and select **Copy prompt for your AI**.
2. Paste the copied prompt into your preferred AI assistant. The prompt instructs the assistant to output a single JSON bundle (`manifest`, `pluginJs`, optional `indexHtml`, optional `iconSvg`) that obeys Meitheal's opaque-origin sandbox and EGM rules.
3. **Step 2 — Paste the answer**: Select **Next: paste the answer**, paste the JSON output, verify the live permission and data-sharing preview, and select **Install plugin**.
4. Meitheal validates the bundle through the exact same ZIP, manifest, SVG sanitization, and re-consent pipeline as uploaded archives. New plugins always start disabled until you review and enable them.

## 10a. Get Listed in the App

Follow this process to list your community plugin in Meitheal's **Reference & Community Plugins** directory:

1. **Host your plugin in a public Git repository** with a clear `README.md`, license file, and source files (`manifest.json`, `plugin.js`, `icon.svg`, optional `index.html`).
2. **Package a reproducible release ZIP** using the Meitheal packager:
   ```bash
   node scripts/pack-plugin.mjs ./path/to/your-plugin
   ```
   Attach the generated `.zip` file to a tagged GitHub Release and record the SHA-256 hash printed by the script.
3. **Verify all 5 Plugin Health checks**:
   - Install the release ZIP in **Settings -> Plugins**.
   - Confirm zero upload warnings, valid `dataSharing` disclosure, and green **Operational** status in **Plugin Health**.
   - Test in both dark and light themes and behind Home Assistant Ingress.
4. **Open a pull request** against the Meitheal repository with your catalog metadata entry:
   ```json
   {
     "id": "your-plugin-slug",
     "name": "Your Plugin Name",
     "version": "1.0.0",
     "author": "your-github-handle",
     "repository": "https://github.com/you/meitheal-plugin-example",
     "releaseZipUrl": "https://github.com/you/meitheal-plugin-example/releases/download/v1.0.0/your-plugin-slug-v1.0.0.zip",
     "sha256": "<sha256 from node scripts/pack-plugin.mjs>",
     "permissions": ["tasks:read", "ui:header-button", "ui:side-panel"],
     "outbound": false
   }
   ```
5. Maintainers review the manifest, `dataSharing` accuracy, SHA-256 digest, and EGM sandbox compliance before adding the listing.

## 11. Troubleshooting

| Symptom | Cause | Corrective Action |
| --- | --- | --- |
| Upload fails with `UNDECLARED_HOST` | `allowedHosts` lists a domain missing from `dataSharing.destinations`. | Add the domain and its purpose to `dataSharing.destinations` in `manifest.json`. |
| Upload fails with `INVALID_ARCHIVE_PATH` | Archive contains `..`, absolute paths, or symbolic links. | Recreate the ZIP archive with `node scripts/pack-plugin.mjs <plugin-dir>`. |
| API call fails with `PERMISSION_DENIED` | The method requires a scope not listed in `permissions`. | Add the required permission to `manifest.json` and re-upload the archive. |
| Gateway returns `403 HOST_BLOCKED` | Target URL is not in `allowedHosts` or resolves to a blocked private/internal IP. | Check `allowedHosts`. For self-hosted tools, use `"$userServer"` and approve the URL in plugin settings. |
| External API returns `401 Unauthorized` | The secret key is missing or misspelled in `{{secret:key}}`. | Open **Settings -> Plugins -> Details -> Secrets** and save the token under the exact key name. |
| Plugin Health shows red `Runtime Error` | `plugin.js` threw an unhandled exception during init or button click. | Inspect the error text in **Plugin Health**, fix `plugin.js`, re-pack, and re-upload. |
| Workspace feels slow after installing a plugin | A plugin frame is polling too often or looping. | Enable **Safe Mode** in **Settings -> Plugins** to stop all plugins, then disable or remove the faulty plugin. |

## 12. Licensing

Meitheal core is licensed under `AGPL-3.0-only` (see [ADR 0022](../decisions/0022-agpl-source-license.md)). External plugins communicate with Meitheal strictly across the versioned JSON-RPC and HTTP boundary. Plugin authors can distribute independent plugins under MIT, Apache-2.0, GPL, AGPL, or private licenses.

## Related Documentation

- [ADR 0028: Sandboxed Plugin Bounded Context and Extension Contract](../decisions/0028-plugin-bounded-context-and-sandbox.md)
- [API and Automation Guide](agent-automation-guide.md)
- [Client-Side Patterns](client-side-patterns.md)
- [ADR 0004: Threat Model Baseline](../decisions/0004-threat-model.md)
- [ADR 0022: AGPL-3.0-only Source License](../decisions/0022-agpl-source-license.md)
