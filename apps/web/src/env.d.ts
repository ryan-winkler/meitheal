/// <reference types="astro/client" />

/**
 * Meitheal global Window extensions
 *
 * All custom `window.__*` properties typed here to avoid `(window as any)`.
 * Grouped by domain context per DDD bounded contexts.
 */
interface Window {
  // ── Ingress & Routing ──
  /** HA ingress base path (set by Layout.astro monkey-patch) */
  __ingress_path?: string
  /** Resolved base path for links and assets */
  __meitheal_base?: string

  // ── PWA ──
  /** Deferred PWA install prompt (beforeinstallprompt event) */
  __pwa_install_prompt?: BeforeInstallPromptEvent | null
  /** Whether the browser supports PWA install */
  __pwa_supported?: boolean
  /** Guard: PWA banner event listeners bound */
  __pwaBannerListenersBound?: boolean
  /** Guard: PWA compact panel listeners bound */
  __pwaCompactListenersBound?: boolean

  // ── Feature Flags ──
  /** Runtime feature flags from API */
  __featureFlags?: Record<string, boolean>

  // ── Search ──
  /** Guard: search hub keyboard listener bound */
  __searchHubKeyboardBound?: boolean

  // ── Area / Filter ──
  /** Currently active board ID */
  __activeArea?: string
  /** Guard: filter state loaded */
  __filterStateLoaded?: boolean
  /** Filter visibility function exposed for cross-component use */
  __isTaskVisible?: (el: HTMLElement, state?: any) => boolean
  /** Backlog mode toggle */
  __backlog_mode?: boolean

  // ── Tasks ──
  /** Pre-fill date for task creation from calendar */
  __prefillTaskDate?: string
  /** Cached users list for assignee dropdowns */
  __meitheal_users?: Array<{ id: string; name: string }>
  /** Current task checklists (detail modal) */
  __currentChecklists?: unknown[]

  // ── Pomodoro ──
  /** Start a pomodoro timer for a task */
  startPomodoro?: (taskId?: string) => void

  // ── Health / Lifecycle ──
  /** Health-check polling interval ID */
  __healthIntervalId?: ReturnType<typeof setInterval>

  // ── Logging ──
  /** Client-side structured logger */
  __mLog?: unknown

  // ── Dynamic keys (page-lifecycle interval guards) ──
  [key: `__meitheal_interval_${string}`]: ReturnType<typeof setInterval> | undefined
}

/** BeforeInstallPromptEvent — not in standard lib */
interface BeforeInstallPromptEvent extends Event {
  readonly platforms: string[]
  readonly userChoice: Promise<{ outcome: "accepted" | "dismissed" }>
  prompt(): Promise<void>
}

declare namespace App {
  interface Locals {
    ingressPath: string | undefined;
    behindIngress: boolean;
    hassioTokenPresent: boolean;
    hassUserId: string | undefined;
    hassIsAdmin: boolean;
    timezone: string;
    weekStart: string;
    dateFormat: import("./lib/date").DateFormat;
  }
}
