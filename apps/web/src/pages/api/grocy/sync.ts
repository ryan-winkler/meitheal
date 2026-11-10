/**
 * Grocy Sync API — Manual Sync Trigger & Status
 *
 * POST /api/grocy/sync — trigger manual sync or enable/disable
 * GET  /api/grocy/sync — get sync status
 *
 * Mirrors /api/todo/sync pattern for API consistency.
 *
 * @domain grocy
 * @bounded-context integration
 */
import type { APIRoute } from "astro";
import {
  syncFromGrocy,
  getGrocySyncStatus,
  startGrocySync,
  stopGrocySync,
} from "@domains/grocy";
import { createGrocyClient } from "../../../lib/grocy-client";
import { logApiError } from "../../../lib/api-logger";

/**
 * GET /api/grocy/sync — returns current sync status
 */
export const GET: APIRoute = async () => {
  try {
    const status = getGrocySyncStatus();
    return new Response(JSON.stringify({ ok: true, sync: status }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    logApiError("grocy-sync", "GET failed", err);
    return new Response(JSON.stringify({ ok: false, error: "Internal server error" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
};

/**
 * POST /api/grocy/sync
 * Body: { action: "sync" | "enable" | "disable", sync_mode?, interval_ms? }
 */
export const POST: APIRoute = async ({ request }) => {
  try {
    let body: {
      action?: "sync" | "enable" | "disable";
      sync_mode?: "import" | "export" | "bidirectional";
      interval_ms?: number;
    };

    try {
      body = await request.json();
    } catch {
      return new Response(JSON.stringify({ ok: false, error: "Invalid JSON body" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    const action = body.action ?? "sync";

    switch (action) {
      case "sync": {
        // Auto-start if not already active
        const currentStatus = getGrocySyncStatus();
        if (!currentStatus.active) {
          const adapter = await createGrocyClient();
          if (!adapter) {
            return new Response(
              JSON.stringify({ ok: false, error: "Grocy not configured — set URL and API key in Settings" }),
              { status: 400, headers: { "Content-Type": "application/json" } },
            );
          }
          startGrocySync(
            {
              syncEnabled: true,
              syncMode: body.sync_mode ?? "bidirectional",
              intervalMs: body.interval_ms ?? 15 * 60 * 1000,
            },
            adapter,
          );
        }

        const result = await syncFromGrocy();
        const status = getGrocySyncStatus();

        const total = result.chores + result.tasks + result.shopping;
        return new Response(
          JSON.stringify({
            ok: true,
            status,
            ...result,
            message:
              total > 0
                ? `Synced ${result.chores} chores, ${result.tasks} tasks, ${result.shopping} shopping`
                : result.errors > 0
                  ? "Sync encountered errors"
                  : "No items to sync",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      case "enable": {
        const adapter = await createGrocyClient();
        if (!adapter) {
          return new Response(
            JSON.stringify({ ok: false, error: "Grocy not configured — set URL and API key in Settings" }),
            { status: 400, headers: { "Content-Type": "application/json" } },
          );
        }

        startGrocySync(
          {
            syncEnabled: true,
            syncMode: body.sync_mode ?? "bidirectional",
            intervalMs: body.interval_ms ?? 15 * 60 * 1000,
          },
          adapter,
        );

        return new Response(
          JSON.stringify({ ok: true, message: "Grocy sync enabled" }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      case "disable": {
        stopGrocySync();
        return new Response(
          JSON.stringify({ ok: true, message: "Grocy sync disabled" }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      default:
        return new Response(JSON.stringify({ ok: false, error: "Unknown action" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
    }
  } catch (err) {
    logApiError("grocy-sync", "POST failed", err);
    return new Response(JSON.stringify({ ok: false, error: "Internal server error" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
};
