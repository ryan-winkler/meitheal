/// <reference types="astro/client" />

declare namespace App {
  interface Locals {
    ingressPath: string | undefined;
    behindIngress: boolean;
    hassUserId: string | undefined;
    hassDisplayName?: string | undefined;
    hassUserName?: string | undefined;
    hassIsAdmin: boolean;
    requestId: string
    timezone: string;
    weekStart: string;
    dateFormat: import("./lib/date").DateFormat;
    /** Automation source: 'browser' (default), 'n8n', 'nodered', 'agent', 'mcp', etc. */
    automationSource: string;
    /** Agent identifier from X-Agent-Id header */
    agentId: string;
    /** W3C trace-id (32 hex chars) — parsed from traceparent header or generated */
    traceId: string;
    /** W3C span-id (16 hex chars) — parsed from traceparent header or generated */
    spanId: string;
    /** W3C trace-flags (2 hex chars, e.g. '01' = sampled) */
    traceFlags: string;
    /** Namespaced digest for an authenticated task retry. */
    taskRetryKey?: string | undefined;
    /** Resolved agent token info (present when authenticated via Bearer token) */
    agentToken?: import("./lib/agent-token-guard").ResolvedAgent | undefined;
    /** Cooperative 25s abort signal for mutating /api/* requests */
    writeAbortSignal?: AbortSignal | undefined;
    /** Per-request set of sprited Tabler icon names registered during SSR */
    usedIcons?: Set<string> | undefined;
    /** True when the active page layout renders <IconSpriteDefs /> */
    hasIconSprite?: boolean | undefined;
  }
}
