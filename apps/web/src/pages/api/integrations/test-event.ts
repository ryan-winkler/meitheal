/**
 * Test Event API — POST /api/integrations/test-event
 *
 * Fires a `meitheal_test` event on the HA event bus so users can
 * verify Node-RED/n8n is receiving events correctly.
 *
 * @domain integrations
 * @bounded-context event-dispatch
 */
import type { APIRoute } from "astro";
import { requireSystemSettingsAdmin } from "../../../lib/settings-security"
import { fireHAEvent } from "../../../domains/ha/ha-events";
import { logApiError } from "../../../lib/api-logger";

export const POST: APIRoute = async ({ locals, request }) => {
  const denied = requireSystemSettingsAdmin(request, locals)
  if (denied) return denied
  try {
    if (!process.env.SUPERVISOR_TOKEN) {
      return new Response(JSON.stringify({
        success: false,
        error: "Not running as HA addon — event bus unavailable in standalone mode",
        hint: "Use the webhook test instead",
      }), {
        status: 422,
        headers: { "content-type": "application/json" },
      });
    }

    const testData = {
      task_id: "test-event",
      title: "Meitheal Test Event",
      status: "test",
      description: "This is a test event to verify Node-RED/n8n integration is working.",
      ticket_key: "MTH-TEST",
      task_type: "test",
    };

    const success = await fireHAEvent("meitheal_test", testData);

    return new Response(JSON.stringify({
      success,
      event_type: "meitheal_test",
      data: testData,
      timestamp: new Date().toISOString(),
      hint: success
        ? "Event fired! Check your Node-RED 'events: all' node with filter 'meitheal_test'"
        : "Event failed to fire — check HA connection in Settings",
    }), {
      status: success ? 200 : 502,
      headers: { "content-type": "application/json" },
    });
  } catch (err) {
    logApiError("test-event", "Failed to fire test event", err);
    return new Response(JSON.stringify({ success: false, error: "Failed to fire test event" }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }
};
