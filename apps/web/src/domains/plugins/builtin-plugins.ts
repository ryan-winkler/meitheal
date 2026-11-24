/**
 * Built-In First-Party External Connectors
 *
 * Production issue-tracker connectors ship built-in and run through the exact
 * same manifest validation, permission checks, write-only secrets, and
 * SSRF-hardened HTTP gateway contracts as uploaded third-party plugins.
 *
 * Example development workspace extensions (Yesterday Carryover, Focus Pulse)
 * are maintained strictly as standalone reference apps under `examples/plugins/`
 * and are not bundled into the live application catalog.
 *
 * @domain plugins
 * @bounded-context plugins
 */
import { createHash } from "node:crypto"
import type { PluginFiles, PluginManifest } from "./types"

export interface BuiltinPluginDefinition {
  manifest: PluginManifest
  files: PluginFiles
  sha256: string
}

const GITHUB_ICON = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M9 19c-4.3 1.4 -4.3 -2.5 -6 -3m12 5v-3.5c0 -1 .1 -1.4 -.5 -2c2.8 -.3 5.5 -1.4 5.5 -6a4.6 4.6 0 0 0 -1.3 -3.2a4.2 4.2 0 0 0 -.1 -3.2s-1.1 -.3 -3.5 1.3a12.3 12.3 0 0 0 -6.2 0c-2.4 -1.6 -3.5 -1.3 -3.5 -1.3a4.2 4.2 0 0 0 -.1 3.2a4.6 4.6 0 0 0 -1.3 3.2c0 4.6 2.7 5.7 5.5 6c-.6 .6 -.6 1.2 -.5 2v3.5" /></svg>`

const GITEA_ICON = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M7 10h10v5a4 4 0 0 1 -4 4h-2a4 4 0 0 1 -4 -4v-5z" /><path d="M17 11h1.5a2.5 2.5 0 0 1 0 5h-1.5" /><path d="M12 10v5" /><circle cx="12" cy="15" r="1" /></svg>`

const GITHUB_CONNECTOR_JS = `MeithealPlugin.registerConnector({
  async testConnection(config, api) {
    const repo = String(config.repository || "").trim()
    const url = repo ? "https://api.github.com/repos/" + repo : "https://api.github.com/user"
    const res = await api.http.request({
      method: "GET",
      url,
      headers: {
        "Accept": "application/vnd.github+json",
        "Authorization": "Bearer {{secret:github_token}}"
      }
    })
    return { ok: res.ok, message: res.ok ? "Connected to GitHub." : "GitHub returned HTTP " + res.status }
  },
  async fetchItems(config, api) {
    const repo = String(config.repository || "").trim()
    if (!repo) return []
    const res = await api.http.request({
      method: "GET",
      url: "https://api.github.com/repos/" + repo + "/issues?state=open&per_page=30",
      headers: {
        "Accept": "application/vnd.github+json",
        "Authorization": "Bearer {{secret:github_token}}"
      }
    })
    if (!res.ok || !Array.isArray(res.json)) return []
    return res.json
      .filter((item) => !item.pull_request)
      .map((issue) => ({
        externalId: "github:" + repo + "#" + issue.number,
        title: "[#" + issue.number + "] " + issue.title,
        description: issue.body || "",
        url: issue.html_url
      }))
  }
})`

const GITEA_CONNECTOR_JS = `MeithealPlugin.registerConnector({
  async testConnection(config, api) {
    const base = String(config.serverUrl || "").replace(/\\/+$/, "")
    const res = await api.http.request({
      method: "GET",
      url: base + "/api/v1/user",
      headers: { "Authorization": "token {{secret:gitea_token}}" }
    })
    return { ok: res.ok, message: res.ok ? "Connected to Gitea." : "Gitea returned HTTP " + res.status }
  },
  async fetchItems(config, api) {
    const base = String(config.serverUrl || "").replace(/\\/+$/, "")
    const repo = String(config.repository || "").trim()
    if (!base || !repo) return []
    const res = await api.http.request({
      method: "GET",
      url: base + "/api/v1/repos/" + repo + "/issues?state=open&limit=30",
      headers: { "Authorization": "token {{secret:gitea_token}}" }
    })
    if (!res.ok || !Array.isArray(res.json)) return []
    return res.json.map((issue) => ({
      externalId: "gitea:" + repo + "#" + issue.number,
      title: "[#" + issue.number + "] " + issue.title,
      description: issue.body || "",
      url: issue.html_url
    }))
  }
})`

function makeBuiltin(manifest: PluginManifest, files: PluginFiles): BuiltinPluginDefinition {
  const sha256 = createHash("sha256")
    .update(JSON.stringify({ manifest, files }))
    .digest("hex")
  return { manifest, files, sha256 }
}

export const BUILTIN_PLUGINS: BuiltinPluginDefinition[] = [
  makeBuiltin(
    {
      id: "github-issues",
      name: "GitHub Issues",
      version: "1.0.0",
      minMeithealVersion: "0.0.2",
      type: "connector",
      description: "Import open GitHub repository issues into Meitheal tasks via the guarded outbound HTTP gateway.",
      author: "Meitheal",
      license: "AGPL-3.0-only",
      icon: "icon.svg",
      entry: "plugin.js",
      sidePanel: false,
      permissions: ["tasks:read", "tasks:write", "boards:read", "http:outbound", "secrets:use", "ui:toast"],
      hooks: [],
      allowedHosts: ["api.github.com"],
      dataSharing: {
        outbound: true,
        destinations: [
          {
            host: "api.github.com",
            purpose: "Read open issues from your configured GitHub repository.",
          },
        ],
        dataTypes: ["repository_slug", "issue_number", "issue_title"],
        summary: "Calls api.github.com through the server gateway using your write-only Personal Access Token.",
      },
      connector: {
        supportsWriteBack: false,
        defaultPollMinutes: 15,
        configFields: [
          {
            key: "repository",
            label: "Repository (owner/name)",
            type: "text",
            required: true,
            placeholder: "octocat/hello-world",
            help: "GitHub repository to import open issues from.",
          },
          {
            key: "apiToken",
            label: "GitHub Personal Access Token",
            type: "secret",
            required: true,
            secretKey: "github_token",
            placeholder: "github_pat_...",
            help: "Stored write-only on the server. Never exposed to browser scripts or exports.",
          },
        ],
      },
    },
    {
      entryJs: GITHUB_CONNECTOR_JS,
      iconSvg: GITHUB_ICON,
    },
  ),
  makeBuiltin(
    {
      id: "gitea-issues",
      name: "Gitea Issues",
      version: "1.0.0",
      minMeithealVersion: "0.0.2",
      type: "connector",
      description: "Import open issues from a self-hosted Gitea or Forgejo server into Meitheal tasks.",
      author: "Meitheal",
      license: "AGPL-3.0-only",
      icon: "icon.svg",
      entry: "plugin.js",
      sidePanel: false,
      permissions: ["tasks:read", "tasks:write", "boards:read", "http:outbound", "secrets:use", "ui:toast"],
      hooks: [],
      allowedHosts: ["$userServer"],
      dataSharing: {
        outbound: true,
        destinations: [
          {
            host: "$userServer",
            purpose: "Read open issues from your administrator-approved self-hosted Gitea server.",
          },
        ],
        dataTypes: ["repository_slug", "issue_number", "issue_title"],
        summary: "Connects only to the self-hosted Gitea URL explicitly approved by your administrator.",
      },
      connector: {
        supportsWriteBack: false,
        defaultPollMinutes: 15,
        configFields: [
          {
            key: "serverUrl",
            label: "Gitea Server URL",
            type: "url",
            required: true,
            bindUserServer: true,
            placeholder: "https://git.home.arpa",
            help: "Base URL of your Gitea or Forgejo server. Approved explicitly for gateway access.",
          },
          {
            key: "repository",
            label: "Repository (owner/name)",
            type: "text",
            required: true,
            placeholder: "household/home-ops",
            help: "Repository slug to import open issues from.",
          },
          {
            key: "apiToken",
            label: "Gitea Access Token",
            type: "secret",
            required: true,
            secretKey: "gitea_token",
            placeholder: "Enter token...",
            help: "Stored write-only on the server and injected via {{secret:gitea_token}}.",
          },
        ],
      },
    },
    {
      entryJs: GITEA_CONNECTOR_JS,
      iconSvg: GITEA_ICON,
    },
  ),
]

export function getBuiltinPluginById(id: string): BuiltinPluginDefinition | undefined {
  return BUILTIN_PLUGINS.find((p) => p.manifest.id === id)
}
