/**
 * Global Window Extensions — Meitheal Application
 *
 * Type declarations for cross-component communication via window globals.
 * These functions are registered by Astro island components and called
 * from other components that need to trigger UI actions.
 *
 * @domain shared
 * @bounded-context cross-component-communication
 */

interface MeithealWindowExtensions {
  // === Task UI ===
  /** Opens task detail panel/modal for the given task ID */
  openTaskDetail?: (taskId: string, commentTarget?: string | null, search?: import("../lib/task-detail-handoff").SearchDetailHandoff) => void;
  openPinnedTaskDetail?: (taskId: string, reconcile: () => void) => void;
  /** Opens the new task creation modal */
  openNewTaskModal?: () => void;

  // === Settings UI ===
  /** Expands an integration settings card by its DOM ID */
  expandIntegrationCard?: (cardId: string) => void;
  /** Opens the AskAssist HA modal */
  openAskHaModal?: (prompt?: string) => void;
  /** Confirm dialog utility registered by Layout.astro */
  confirmDialog?: typeof import("../lib/confirm-dialog").confirmDialog;
  /** Prompt dialog utility registered by prompt-dialog.ts */
  promptDialog?: typeof import("../lib/prompt-dialog").promptDialog;

  // === App State ===
  /** Currently active board ID for filtering */
  __activeArea?: string;
  /** Base path for Meitheal (set by Layout.astro for ingress) */
  __meitheal_base?: string;
  /** HA ingress path prefix */
  __ingress_path?: string;
  /** Global settings object (dateFormat, timezone, etc.) */
  mSettings?: {
    dateFormat?: string;
    timezone?: string;
    [key: string]: unknown;
  };
  /** I18n translation map */
  mI18n?: { locale: import("../lib/locale").Locale; get: (key: string, locale?: import("../lib/locale").Locale) => string };

  // === Strategic Lens ===
  /** Attaches strategic lens evaluator for a task (registered by StrategicEvaluator.astro) */
  attachStrategicLens?: (taskId: string, taskType: string, frameworkPayloadStr: string, cachedSettings: Record<string, unknown>) => void;

  // === Gamification ===
  /** Triggers confetti animation (registered by Confetti.astro) */
  triggerConfetti?: () => void;

  // === PWA ===
  /** Stored beforeinstallprompt event for PWA install */
  __pwa_install_prompt?: BeforeInstallPromptEvent | null;
  /** Whether PWA is supported in this browser context */
  __pwa_supported?: boolean;

  // === Logging ===
  /** Global logger bridge for is:inline scripts (registered by Layout.astro) */
  __mLog?: (domain: string, component?: string) => import("../lib/client-logger").ClientLogger;

  // === Cleanup ===
  /** AbortController cleanup for table resize listener */
  __tableResizeCleanup?: () => void;

  // === Search Hub & Helpers ===
  /** Opens the search hub modal, optionally pre-filling and/or pre-scoping */
  openSearchHub?: (options?: string | { prefill?: string; scope?: string }) => void;
  /** Closes the search hub modal */
  /** Guard to prevent duplicate keyboard listeners for search hub */

  // === Intervals / Singleton Guards ===
  /** Health check interval ID (prevents accumulation across navigations) */
  __healthIntervalId?: ReturnType<typeof setInterval>;
  /** PWA banner event listeners already bound */
  __pwaBannerListenersBound?: boolean;
  /** PWA compact install listeners already bound */
  __pwaCompactListenersBound?: boolean;

  // === Cached Data ===
  /** Cached users list from API (used by NewTaskModal assignee dropdown) */
  __meitheal_users?: Array<{ id: string; display_name?: string; name?: string }>;
  /** Backlog mode setting (visible | hidden | disabled) */
  __backlog_mode?: string;
  /** Feature flags from settings */
  __featureFlags?: Record<string, boolean>;

  // === Cross-Component Functions ===
  /** Filter visibility check registered by FilterToolbar */
  __isTaskVisible?: (el: HTMLElement, state?: any) => boolean;
  /** Show toast notification */
  showToast?: (message: string, type?: string) => void;
  /** Start pomodoro timer for a task */
  startPomodoro?: (taskId?: string) => void;

  /** Filter state loaded flag (set by FilterToolbar) */
  __filterStateLoaded?: boolean;

  // === n8n / Node-RED ===
  /** n8n diagnostics initializer (set by settings-integrations-n8n-controller) */
  __initN8nDiagnostics?: (forceRefresh?: boolean) => void;

  // === Calendar ===
  /** Pre-fill date for new task creation from calendar day drawer */
  __prefillTaskDate?: string;
}

/** BeforeInstallPromptEvent — not in lib.dom.d.ts */
interface BeforeInstallPromptEvent extends Event {
  readonly platforms: string[];
  readonly userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
  prompt(): Promise<void>;
}

declare global {
  interface Window extends MeithealWindowExtensions {}
}

export {};
