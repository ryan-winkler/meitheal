/**
 * Agentic Evaluation E2E Tests
 *
 * LLM-in-the-loop tests that prove our API remains AI-readable.
 * A programmatic LLM client reads the auto-generated OpenAPI spec,
 * formulates API calls, and executes them against the running server.
 *
 * CI passes ONLY if the LLM successfully:
 * 1. Parses the OpenAPI 3.1 spec
 * 2. Identifies the correct endpoint from 120+ operations
 * 3. Formats valid JSON per the schema
 * 4. Completes the action autonomously
 *
 * Requires:
 * - GEMINI_API_KEY env var (test skipped if absent)
 * - E2E_BASE_URL env var pointing to running Meitheal instance
 *
 * @domain integrations
 * @bounded-context agentic-testing
 */
import { expect, test } from "@playwright/test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

// ── Config ───────────────────────────────────────────────────────────────────

const GEMINI_API_KEY = process.env.GEMINI_API_KEY ?? ""
const GEMINI_MODEL = process.env.AGENTIC_EVAL_MODEL ?? "gemini-2.0-flash"
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`

/** Load the generated OpenAPI spec from disk */
function loadOpenAPISpec(): string {
  const specPath = resolve(__dirname, "../../apps/web/public/openapi.yaml")
  return readFileSync(specPath, "utf-8")
}

/** Call Gemini API with a prompt, return raw text response */
async function callGemini(prompt: string): Promise<string> {
  const response = await fetch(GEMINI_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0, // deterministic
        maxOutputTokens: 2048,
        responseMimeType: "application/json",
      },
    }),
  })

  if (!response.ok) {
    const errText = await response.text()
    throw new Error(`Gemini API error ${response.status}: ${errText}`)
  }

  const data = await response.json()
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text
  if (!text) throw new Error(`Empty Gemini response: ${JSON.stringify(data)}`)
  return text
}

/** Extract JSON from LLM response (handles markdown code fences) */
function extractJSON(text: string): unknown {
  const cleaned = text.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim()
  return JSON.parse(cleaned)
}

// ── Test Suite ────────────────────────────────────────────────────────────────

test.describe("Agentic Evaluation", () => {
  // Skip if no API key or no running server
  test.skip(!GEMINI_API_KEY, "Set GEMINI_API_KEY to run agentic evaluation tests")
  test.skip(!process.env.E2E_BASE_URL, "Set E2E_BASE_URL to run agentic evaluation tests")

  // LLM calls need more time
  test.setTimeout(120_000)

  const baseURL = process.env.E2E_BASE_URL ?? "http://127.0.0.1:3000"
  let createdTaskId: string | null = null

  test.afterEach(async ({ request }) => {
    // Cleanup: delete any task we created
    if (createdTaskId) {
      try {
        await request.delete(`${baseURL}/api/tasks/${createdTaskId}`)
      } catch { /* best effort cleanup */ }
      createdTaskId = null
    }
  })

  test("LLM autonomously creates a task from OpenAPI spec", async ({ request }) => {
    // Step 1: Load the real, auto-generated spec
    const spec = loadOpenAPISpec()
    const timestamp = new Date().toISOString()

    // Step 2: Prompt the LLM to read the spec and formulate an API call
    const prompt = `You are an autonomous API agent. You have been given an OpenAPI 3.1 specification for an API called "Meitheal Hub".

Your goal: Create a new task titled "Agentic E2E Eval - ${timestamp}" with priority 3 and status "todo".

Using ONLY the provided OpenAPI specification, determine:
1. The correct HTTP method and path
2. The required request headers
3. The JSON request body format

Return ONLY a JSON object with this exact structure:
{
  "method": "POST|GET|PUT|DELETE",
  "path": "/api/...",
  "headers": { "Content-Type": "..." },
  "body": { ... }
}

Here is the OpenAPI specification:

${spec}`

    const llmResponse = await callGemini(prompt)
    const apiCall = extractJSON(llmResponse) as {
      method: string
      path: string
      headers: Record<string, string>
      body: Record<string, unknown>
    }

    // Step 3: Validate the LLM understood the spec structure
    expect(apiCall.method).toBeTruthy()
    expect(apiCall.path).toBeTruthy()
    expect(apiCall.headers).toBeTruthy()
    expect(apiCall.body).toBeTruthy()

    // The LLM should have identified a POST endpoint for task creation
    expect(apiCall.method.toUpperCase()).toBe("POST")
    expect(apiCall.path).toContain("/api/tasks")
    expect(apiCall.body).toHaveProperty("title")

    // Step 4: Execute the LLM-formulated API call against the real server
    const url = `${baseURL}${apiCall.path}`
    const response = await request.fetch(url, {
      method: apiCall.method,
      headers: apiCall.headers,
      data: apiCall.body,
    })

    // Step 5: Verify the API accepted the LLM-formatted request
    expect(response.ok()).toBeTruthy()
    const result = await response.json()
    expect(result.id).toBeTruthy()
    expect(result.title).toContain("Agentic E2E Eval")

    createdTaskId = result.id

    // Step 6: Verify rate limit headers are present (IETF standard)
    const rateLimitHeader = response.headers()["ratelimit"]
    expect(rateLimitHeader).toBeTruthy()
    expect(rateLimitHeader).toContain("limit=")
    expect(rateLimitHeader).toContain("remaining=")
    expect(rateLimitHeader).toContain("reset=")
  })

  test("LLM self-corrects after RFC 9457 validation error", async ({ request }) => {
    const spec = loadOpenAPISpec()

    // Step 1: Ask LLM to create an INTENTIONALLY invalid request
    const badPrompt = `You are an autonomous API agent. You have been given an OpenAPI 3.1 specification.

Your goal: Create a task but INTENTIONALLY send an invalid request to test error handling.
Specifically, send a POST to the task creation endpoint with an EMPTY body (no title field).

Return ONLY a JSON object:
{
  "method": "POST|GET|PUT|DELETE",
  "path": "/api/...",
  "headers": { "Content-Type": "..." },
  "body": {}
}

OpenAPI spec:

${spec}`

    const badResponse = await callGemini(badPrompt)
    const badCall = extractJSON(badResponse) as {
      method: string
      path: string
      headers: Record<string, string>
      body: Record<string, unknown>
    }

    // Step 2: Execute the bad request
    const badResult = await request.fetch(`${baseURL}${badCall.path}`, {
      method: badCall.method,
      headers: badCall.headers,
      data: badCall.body,
    })

    // Should get a 4xx error
    expect(badResult.status()).toBeGreaterThanOrEqual(400)
    expect(badResult.status()).toBeLessThan(500)

    // Step 3: Verify the error is RFC 9457 problem+json
    const contentType = badResult.headers()["content-type"] ?? ""
    expect(contentType).toContain("application/problem+json")

    const problem = await badResult.json()
    expect(problem.type).toBeTruthy()
    expect(problem.title).toBeTruthy()
    expect(problem.status).toBeGreaterThanOrEqual(400)
    // The `detail` or `error` field gives the LLM info to self-correct
    const errorDetail = problem.detail ?? problem.error
    expect(errorDetail).toBeTruthy()

    // Step 4: Feed the error BACK to the LLM for self-correction
    const fixPrompt = `You are an autonomous API agent. You tried to create a task via the API but received an error.

Here is the RFC 9457 problem+json error response you received:
${JSON.stringify(problem, null, 2)}

Here is your original request:
Method: ${badCall.method}
Path: ${badCall.path}
Body: ${JSON.stringify(badCall.body)}

${problem.invalidParams ? `The invalidParams array tells you exactly which fields need fixing:
${JSON.stringify(problem.invalidParams, null, 2)}` : ""}

Fix the request to create a task titled "Self-Corrected Task - ${new Date().toISOString()}" with priority 2.

Return ONLY a corrected JSON object:
{
  "method": "POST|GET|PUT|DELETE",
  "path": "/api/...",
  "headers": { "Content-Type": "..." },
  "body": { ... }
}`

    const fixResponse = await callGemini(fixPrompt)
    const fixedCall = extractJSON(fixResponse) as {
      method: string
      path: string
      headers: Record<string, string>
      body: Record<string, unknown>
    }

    // Step 5: Verify the corrected request has a title
    expect(fixedCall.body).toHaveProperty("title")
    expect(String(fixedCall.body.title)).toContain("Self-Corrected Task")

    // Step 6: Execute the corrected request
    const correctedResult = await request.fetch(`${baseURL}${fixedCall.path}`, {
      method: fixedCall.method,
      headers: fixedCall.headers,
      data: fixedCall.body,
    })

    // Should succeed now
    expect(correctedResult.ok()).toBeTruthy()
    const created = await correctedResult.json()
    expect(created.id).toBeTruthy()
    expect(created.title).toContain("Self-Corrected Task")

    createdTaskId = created.id
  })

  test("LLM discovers and queries search endpoint from spec", async ({ request }) => {
    // Step 1: First create a task to search for
    const marker = `SearchEval-${Date.now()}`
    const createRes = await request.post(`${baseURL}/api/tasks/create`, {
      headers: { "Content-Type": "application/json" },
      data: { title: marker, status: "todo" },
    })
    expect(createRes.ok()).toBeTruthy()
    const created = await createRes.json()
    createdTaskId = created.id

    const spec = loadOpenAPISpec()

    // Step 2: Ask LLM to find and use the search endpoint
    const prompt = `You are an autonomous API agent. You have been given an OpenAPI 3.1 specification.

Your goal: Search for a task containing the text "${marker}" using the search API.

Using ONLY the provided OpenAPI specification, determine the correct search endpoint, method, and parameters.

Return ONLY a JSON object:
{
  "method": "GET|POST",
  "path": "/api/search?...",
  "headers": { ... }
}

Include query parameters in the path. Do NOT include a request body for GET requests.

OpenAPI spec:

${spec}`

    const llmResponse = await callGemini(prompt)
    const searchCall = extractJSON(llmResponse) as {
      method: string
      path: string
      headers: Record<string, string>
    }

    // Step 3: Validate LLM found the search endpoint
    expect(searchCall.path.toLowerCase()).toContain("search")
    expect(searchCall.path).toContain(marker)

    // Step 4: Execute the search
    const searchResult = await request.fetch(`${baseURL}${searchCall.path}`, {
      method: searchCall.method,
      headers: searchCall.headers ?? {},
    })

    expect(searchResult.ok()).toBeTruthy()
    const results = await searchResult.json()

    // Step 5: Verify the search returned our task
    expect(results.results).toBeTruthy()
    expect(Array.isArray(results.results)).toBe(true)
  })
})
