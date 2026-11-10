import type { APIRoute } from "astro";
import { createLabel, listLabels } from "@domains/labels"
import { stripHtml } from "../../lib/strip-html";
import { apiError, apiJson } from "../../lib/api-response";
import { createLogger, defaultRedactionPatterns } from "@meitheal/domain-observability";

const logger = createLogger({
  service: "meitheal-web",
  env: process.env.NODE_ENV ?? "development",
  minLevel: "info",
  enabledCategories: ["tasks", "audit", "observability"],
  redactPatterns: defaultRedactionPatterns,
  auditEnabled: true,
});

/**
 * Native Labels API.
 * GET /api/labels — list all labels
 * POST /api/labels — create a label { title, hex_color }
 */

export const GET: APIRoute = async () => {
  try {
    const labels = await listLabels()
    return apiJson(labels.map(({ id, title, hexColor }) => ({
      id,
      title,
      hex_color: hexColor.slice(1),
    })))
  } catch (err) {
    logger.log("error", {
      event: "api.labels.get.failed",
      domain: "tasks",
      component: "labels-api",
      request_id: crypto.randomUUID(),
      message: "Internal server error",
    });
    return apiError("Failed to list labels");
  }
};

export const POST: APIRoute = async ({ request }) => {
  try {
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const input = typeof body.title === "string" ? body.title : ""
    const title = stripHtml(input.trim())

    if (!title) {
      return apiError("title is required", 400);
    }
    if (title.length > 100) {
      return apiError("title must be 100 characters or less", 400);
    }

    const hexColor = typeof body.hex_color === "string" && /^#[0-9a-fA-F]{6}$/.test(body.hex_color)
      ? body.hex_color
      : "#6b7280";

    const label = await createLabel(input, hexColor)
    return apiJson({ id: label.id, title: label.title, hex_color: label.hexColor.slice(1) }, 201)
  } catch (err) {
    logger.log("error", {
      event: "api.labels.post.failed",
      domain: "tasks",
      component: "labels-api",
      request_id: crypto.randomUUID(),
      message: "Internal server error",
    });
    return apiError("Failed to create label");
  }
};
