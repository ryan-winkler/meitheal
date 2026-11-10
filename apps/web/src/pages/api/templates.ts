/**
 * Task Templates API — Phase 31
 *
 * CRUD for reusable task blueprints.
 * POST with `template_id` creates a new task from the saved template.
 *
 * @domain domain-tasks
 * @kcs template_json schema: { title, description, priority, labels, task_type,
 *   recurrence_rule, checklists, custom_fields, area_id }
 */
import type { APIRoute } from "astro"
import { ensureSchema, getPersistenceClient } from "@domains/tasks/persistence/store"
import { TemplateRepository } from "@domains/tasks/persistence/template-repository"
import { logApiError } from "../../lib/api-logger"

export const GET: APIRoute = async () => {
  try {
    await ensureSchema()
    const repo = new TemplateRepository(getPersistenceClient())
    const templates = await repo.findAll()
    return new Response(JSON.stringify({ templates }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })
  } catch (error) {
    return new Response(
      JSON.stringify({ error: "Failed to fetch templates" }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    )
  }
}

export const POST: APIRoute = async ({ request }) => {
  try {
    await ensureSchema()
    const repo = new TemplateRepository(getPersistenceClient())

    let body: Record<string, unknown>
    try {
      body = await request.json() as Record<string, unknown>
    } catch {
      return new Response(
        JSON.stringify({ error: "Invalid JSON body" }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      )
    }

    // If template_id is provided, instantiate a task from template
    if (body.template_id) {
      const tmpl = await repo.findById(String(body.template_id))
      if (!tmpl) {
        return new Response(
          JSON.stringify({ error: "Template not found" }),
          { status: 404, headers: { "Content-Type": "application/json" } },
        )
      }

      const template = JSON.parse(String(tmpl.template_json ?? "{}")) as Record<string, unknown>
      const taskId = crypto.randomUUID()

      await repo.instantiateFromTemplate(taskId, template)

      return new Response(
        JSON.stringify({ id: taskId, created_from_template: body.template_id }),
        { status: 201, headers: { "Content-Type": "application/json" } },
      )
    }

    // Otherwise, create a new template
    const { name, template_json, icon } = body as {
      name?: string
      template_json?: Record<string, unknown>
      icon?: string
    }

    if (!name || typeof name !== "string" || name.trim().length === 0) {
      return new Response(
        JSON.stringify({ error: "name is required" }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      )
    }

    if (name.trim().length > 100) {
      return new Response(
        JSON.stringify({ error: "name must be 100 characters or fewer" }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      )
    }

    const id = crypto.randomUUID()
    const position = await repo.getNextPosition()

    await repo.create({
      id,
      name: name.trim(),
      templateJson: JSON.stringify(template_json ?? {}),
      icon: icon ?? "📝",
      position,
    })

    return new Response(
      JSON.stringify({ id, name: name.trim(), position }),
      { status: 201, headers: { "Content-Type": "application/json" } },
    )
  } catch (error) {
    logApiError("templates", "POST error", error)
    return new Response(
      JSON.stringify({ error: "Failed to process template request" }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    )
  }
}

export const DELETE: APIRoute = async ({ request }) => {
  try {
    await ensureSchema()
    const repo = new TemplateRepository(getPersistenceClient())
    const url = new URL(request.url)
    const id = url.searchParams.get("id")

    if (!id) {
      return new Response(
        JSON.stringify({ error: "id query parameter is required" }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      )
    }

    await repo.delete(id)

    return new Response(JSON.stringify({ deleted: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })
  } catch (error) {
    return new Response(
      JSON.stringify({ error: "Failed to delete template" }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    )
  }
}
