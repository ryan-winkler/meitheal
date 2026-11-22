/**
 * Server-rendered contextual help copy for Settings sections
 * (Look & Feel, Navigation & Shortcuts, and Webserver).
 * Kept server-only so static prose never bloats client JS bundles.
 *
 * @domain navigation
 */

export interface SettingsHelpTopic {
  title: string
  body: string
  tip?: string
}

export interface WebserverHelpDoc {
  title: string
  paragraphs: string[]
  envKey?: string
  provKey?: string
}

export const SETTINGS_HELP_TOPICS: Record<string, SettingsHelpTopic> = {
  theme: {
    title: "Theme Mode",
    body: "Switch between Emerald Isle (dark), Knight Rider (high-contrast charcoal), Light (warm paper), Auto (follows Home Assistant or OS), or a Custom CSS theme.",
    tip: "Changes preview live immediately across the whole workspace. Click Save to commit or Discard to revert.",
  },
  matchHaTheme: {
    title: "Match Home Assistant Theme",
    body: "When Meitheal runs inside Home Assistant Ingress, this reads your active Home Assistant theme palette and adapts colors automatically while maintaining WCAG AA text contrast.",
    tip: "Standalone browser sessions fall back to your chosen Meitheal theme.",
  },
  accentColor: {
    title: "Accent Color & Navigation Color",
    body: "Pick a preset swatch or custom color for buttons, focus rings, active links, and the Accent-tinted navigation bar.",
    tip: "Pairs with Navigation color: choose Accent-tinted below to tint your sidebar or top bar with your chosen accent.",
  },
  navLayout: {
    title: "Navigation Layout (Sidebar vs Top Bar)",
    body: "Sidebar keeps destinations in a collapsible vertical rail. Top navigation moves them to a full-width horizontal bar that uses Tabler overflow to automatically tuck extra links into More as the screen narrows.",
    tip: "Phones and compact Home Assistant Companion screens always keep the touch-friendly mobile tab bar.",
  },
  navTone: {
    title: "Navigation Color",
    body: "Choose whether navigation matches your page theme, stays a dedicated dark slate bar, or adopts an accent-tinted surface derived from your active theme or personal accent color.",
    tip: "Works alongside every theme mode, base palette, and accent color with automatic high-contrast text.",
  },
  navStyle: {
    title: "Navigation Edges",
    body: "Attached docks the sidebar or top bar flush to the window edge. Floating adds an inset frame, rounded corners, and subtle elevation.",
  },
  sidebarBehavior: {
    title: "Sidebar Behavior",
    body: "Choose whether the desktop sidebar remembers its last state, stays expanded, starts folded as an icon rail, or expands smoothly on pointer hover and keyboard focus.",
    tip: "Applies when Navigation layout is set to Sidebar. Press Ctrl/Cmd+B anytime to toggle.",
  },
  appearanceDensity: {
    title: "Typography, Base Palette & Surface Density",
    body: "Fine-tune font family, neutral gray ramp, corner roundness, page width, sticky header behavior, and floating slide-over panels.",
    tip: "Stored per device so your desktop monitor and Home Assistant wall tablet can use different layouts.",
  },
  navLookFeelHandoff: {
    title: "Navigation Appearance Moved to Look & Feel",
    body: "Visual layout controls (Sidebar vs Top navigation, Navigation color, Floating edges, and Hover behavior) now live in Look & Feel alongside Theme and Accent Color so you can preview them all together.",
  },
  keyboardShortcuts: {
    title: "Editable Keyboard Shortcuts",
    body: "Click any shortcut box and press a key or key combination (such as Ctrl+K, Shift+N, or D) to rebind it. Press Escape to cancel, or Backspace/Delete to unbind.",
    tip: "Modifier shortcuts (Ctrl/Cmd, Alt, Shift) work even when Single-key shortcuts are turned off. Press ? anywhere to view your active shortcuts.",
  },
  singleKeyShortcuts: {
    title: "Single-Key Shortcuts",
    body: "Allows fast one-key shortcuts like N (New task), / (Search), D (Dashboard), and 1–4 (Task views) when not typing in an input field.",
    tip: "Turn this off if you use assistive tools or browser extensions that rely on single-letter keys; modifier combos like Ctrl+K stay active.",
  },
  sidebarMenu: {
    title: "Sidebar & Top Bar Menu",
    body: "Show, hide, rename, or reorder destinations and add custom links. Both the vertical sidebar and the horizontal top navigation bar follow this exact order.",
    tip: "For Home Assistant native links, use ingress-safe relative paths (like /today or /boards) or full https:// URLs.",
  },
  taskNavTypes: {
    title: "New Task Types Menu",
    body: "Control which quick-create task types appear under the New Task split button and pin your favorites directly into the navigation bar.",
  },
  personalLabels: {
    title: "Personal Labels (Home Assistant Native)",
    body: "Rename workspace concepts such as Boards, Areas, and Projects to match how your household talks (for example: Rooms, Chores, or Lists). Stored per Home Assistant account and language.",
    tip: "Open Meitheal via Home Assistant Ingress to customize personal labels for your HA account.",
  },
}

export const WEBSERVER_HELP_DOCS: Record<string, WebserverHelpDoc> = {
  serverName: {
    title: "Server name",
    paragraphs: ["Friendly name identifying this Meitheal server across Home Assistant add-on options and agent discovery. Unified with MEITHEAL_SERVER_NAME."],
    envKey: "serverName",
    provKey: "serverName",
  },
  internalUrl: {
    title: "Internal URL",
    paragraphs: ["Local network URL shared with home devices and automations (e.g. http://meitheal.local:3000). Leave blank to auto-detect, or override via MEITHEAL_INTERNAL_URL."],
    envKey: "internalUrl",
    provKey: "internalUrl",
  },
  externalUrl: {
    title: "External URL",
    paragraphs: ["Public HTTPS address for remote access (e.g. https://tasks.example.com). Used as the primary MCP Server URL base and allowed MCP origin. Unified with MEITHEAL_EXTERNAL_URL and SITE_URL."],
    envKey: "externalUrl",
    provKey: "externalUrl",
  },
  homeAssistantUrl: {
    title: "Home Assistant URL",
    paragraphs: ["Base URL of your Home Assistant instance (e.g. https://ha.0ii.top or http://homeassistant.local:8123). Builds direct links to {Domain}/config/ai and stays unified with ha_url, Supervisor discovery, and HA_BASE_URL."],
    envKey: "homeAssistantUrl",
    provKey: "homeAssistantUrl",
  },
  portsSpec: {
    title: "TCP Port(s)",
    paragraphs: ["Single port (3000), list (3000, 8095), or range (3000-3005, max 32). Unified with MEITHEAL_PORTS and PORT; port changes apply on server or add-on restart."],
    envKey: "ports",
    provKey: "portsSpec",
  },
  mcp: {
    title: "Model Context Protocol (MCP)",
    paragraphs: ["Add this URL to your AI assistant or Home Assistant ({Domain}/config/ai). Follows External URL, Internal URL, or current origin, and syncs with AI & Agent Access → Agent Protocols."],
  },
  supervisor: {
    title: "Home Assistant Supervisor & Services",
    paragraphs: ["Reads host interfaces, Home Assistant Core URLs, and Supervisor Services inside Home Assistant OS, and exposes webserver options via /api/ha/services."],
  },
  tlsEnabled: {
    title: "Enable SSL/TLS",
    paragraphs: ["Enables direct HTTPS using the certificate and key below. Keep off if Home Assistant Ingress, a reverse proxy, or a VPN handles HTTPS."],
  },
  sslCertificate: {
    title: "SSL Certificate",
    paragraphs: ["Absolute path (e.g. /ssl/fullchain.pem) or inline PEM certificate block."],
  },
  sslPrivateKey: {
    title: "SSL Private Key",
    paragraphs: ["Absolute path (e.g. /ssl/privkey.pem) or inline PEM key. Stored keys are redacted in API responses; leave blank to keep the existing key."],
  },
  bindAddress: {
    title: "Bind to IP/interface",
    paragraphs: ["0.0.0.0 listens on all IPv4 interfaces, 127.0.0.1 restricts to loopback, :: listens on IPv6/dual-stack. Unified with MEITHEAL_HOST and HOST."],
    envKey: "bindAddress",
    provKey: "bindAddress",
  },
  verify: {
    title: "Verify configuration",
    paragraphs: ["Checks ports, URLs, bind interface, live listener alignment, SSL/TLS pairing, and Home Assistant Supervisor connectivity before saving."],
  },
}

export function safeJsonForScript(data: unknown): string {
  return JSON.stringify(data).replace(/</g, "\\u003c")
}
