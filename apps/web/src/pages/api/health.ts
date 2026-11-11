import type { APIRoute } from "astro";
import { ensureSchema, getPersistenceClient, getDbIntegrityStatus, getSchemaVersion } from "@domains/tasks/persistence/store";
import { apiJson } from "../../lib/api-response";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { supervisorFetch } from "../../lib/supervisor-fetch";
import { getHAConnectionStatus } from "@domains/ha/ha-connection";

/** Process startup time for uptime calculation. */
const startedAt = Date.now();

/**
 * Read addon version from config.yaml at startup.
 * Falls back to package.json version or "unknown".
 */
function getAddonVersion(): string {
  // Prefer MEITHEAL_VERSION env var (set by run.sh in Docker)
  if (process.env.MEITHEAL_VERSION) return process.env.MEITHEAL_VERSION;
  try {
    // In HA addon: /config.yaml is mounted; in dev: ../../meitheal-hub/config.yaml
    for (const p of ["/config.yaml", resolve(process.cwd(), "../../meitheal-hub/config.yaml")]) {
      try {
        const yaml = readFileSync(p, "utf-8");
        const match = yaml.match(/^version:\s*["']?([^"'\n]+)["']?/m);
        if (match?.[1]) return match[1];
      } catch { /* try next */ }
    }
  } catch { /* fallback */ }
  return "unknown";
}

const VERSION = getAddonVersion();

/**
 * GET /api/health — Readiness & liveness probe.
 * Returns service status, version, uptime, database connectivity,
 * integrity check result (PRA-24), and schema version (PRA-23).
 */
export const GET: APIRoute = async () => {
  const now = Date.now();
  const uptimeMs = now - startedAt;

  try {
    await ensureSchema();
    const client = getPersistenceClient();
    // Simple connectivity check
    await client.execute("SELECT 1");

    // PRA-14: Supervisor API connectivity probe
    const haMode = process.env.SUPERVISOR_TOKEN ? "ha-addon" : "standalone";
    let supervisorReachable = false;
    let addonSlug = "unknown";
    if (process.env.SUPERVISOR_TOKEN) {
      try {
        const res = await supervisorFetch("/addons/self/info", {}, 3_000);
        if (res && res.ok) {
          supervisorReachable = true;
          const data = await res.json() as { data?: { slug?: string } };
          addonSlug = data?.data?.slug ?? "unknown";
        }
      } catch { /* Supervisor unreachable — non-fatal */ }
    }

    // HA WebSocket connection status
    const haWsStatus = getHAConnectionStatus();

    const integrityOk = getDbIntegrityStatus()
    return apiJson({
      status: integrityOk ? "ok" : "degraded",
      service: "meitheal-web",
      version: VERSION,
      time: new Date(now).toISOString(),
      uptime_seconds: Math.floor(uptimeMs / 1000),
      db_status: "connected",
      db_integrity: integrityOk ? "ok" : "failed",
      schema_version: getSchemaVersion(),
      ha_mode: haMode,
      supervisor_reachable: supervisorReachable,
      addon_slug: addonSlug,
      ha_websocket: haWsStatus,
    }, integrityOk ? 200 : 503);
  } catch (error) {
    return apiJson({
      status: "degraded",
      service: "meitheal-web",
      version: VERSION,
      time: new Date(now).toISOString(),
      uptime_seconds: Math.floor(uptimeMs / 1000),
      db_status: "error",
      error: error instanceof Error ? error.message : "unknown",
    }, 503);
  }
};

/** HEAD /api/health — Lightweight liveness check (no body). */
export const HEAD: APIRoute = async () => {
  try {
    await ensureSchema();
    return new Response(null, { status: 200 });
  } catch {
    return new Response(null, { status: 503 });
  }
};
