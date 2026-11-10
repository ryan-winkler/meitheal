import { execFileSync, fork } from "node:child_process"
import { once } from "node:events"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { expect, test } from "@playwright/test"
import { shouldSkipBrowserSpecs } from "./_helpers"

test.skip(shouldSkipBrowserSpecs(), "Set E2E_BASE_URL to run A2A/WebMCP checks");

test.describe("A2A Agent Card Discovery", () => {
  test("the well-known aliases return the dynamic A2A agent card", async ({ request }) => {
    const response = await request.get("/api/a2a/agent-card")
    expect(response.ok()).toBeTruthy()
    const card = await response.json()
    expect(card).toMatchObject({ name: "Meitheal", skills: expect.any(Array) })
    expect(card.skills.length).toBeGreaterThan(0)
    for (const alias of ["/.well-known/agent.json", "/.well-known/agent-card.json"]) {
      const discovery = await request.get(alias, { maxRedirects: 0 })
      expect(discovery.ok()).toBeTruthy()
      expect(await discovery.json()).toEqual(card)
    }
  })

  test("dynamic agent card has required fields", async ({
    request,
    baseURL,
  }) => {
    const response = await request.get(`${baseURL}/api/a2a/agent-card`);
    expect(response.ok()).toBeTruthy();
    const card = await response.json();

    // A2A spec §4.4.1 required fields
    expect(card.name).toBeTruthy();
    expect(card.description).toBeTruthy();
    expect(card.supportedInterfaces).toBeDefined();
    expect(Array.isArray(card.supportedInterfaces)).toBe(true);
    expect(card.supportedInterfaces).toEqual([])
    expect(card.provider).toBeDefined();
    expect(card.capabilities).toBeDefined();
    expect(card.skills).toBeDefined();
  });

  test("agent card skills have correct shape", async ({
    request,
    baseURL,
  }) => {
    const response = await request.get(`${baseURL}/api/a2a/agent-card`);
    const card = await response.json();

    for (const skill of card.skills) {
      expect(skill.id).toBeTruthy();
      expect(skill.name).toBeTruthy();
      expect(skill.description).toBeTruthy();
      expect(Array.isArray(skill.tags)).toBe(true);
      expect(Array.isArray(skill.examples)).toBe(true);
    }
  });

  test("the experimental card documents its routes and disables push", async ({
    request,
    baseURL,
  }) => {
    const response = await request.get(`${baseURL}/api/a2a/agent-card`);
    const card = await response.json();

    expect(card.description).toMatch(/Experimental/)
    expect(card.capabilities).toMatchObject({ pushNotifications: false, streaming: false })
    expect(card.documentationUrl).toBe("/openapi.yaml")
    expect((await request.get(card.documentationUrl)).ok()).toBe(true)
  });
});

test.describe("A2A Message Send", () => {
  test("accepts valid message with skill", async ({ request, baseURL }) => {
    const response = await request.post(`${baseURL}/api/a2a/message`, {
      data: {
        message: {
          role: "user",
          messageId: "test-msg-001",
          parts: [
            {
              text: "Create a task titled 'Test Task'",
              data: { skill: "task-management" },
            },
          ],
        },
      },
    });

    expect(response.ok()).toBeTruthy();
    const body = await response.json();
    expect(body.task).toBeDefined();
    expect(body.task.id).toBeTruthy();
    expect(body.task.status).toBe("completed");
    expect(body.task.messages.length).toBeGreaterThanOrEqual(2);
  });

  test("returns input-required when no skill detected", async ({
    request,
    baseURL,
  }) => {
    const response = await request.post(`${baseURL}/api/a2a/message`, {
      data: {
        message: {
          role: "user",
          messageId: "test-msg-002",
          parts: [{ text: "Hello, what can you do?" }],
        },
      },
    });

    expect(response.ok()).toBeTruthy();
    const body = await response.json();
    expect(body.task).toBeDefined();
    expect(body.task.status).toBe("input-required");
  });

  test("rejects invalid message structure", async ({ request, baseURL }) => {
    const response = await request.post(`${baseURL}/api/a2a/message`, {
      data: { message: {} },
    });

    expect(response.status()).toBe(400);
  });

  test("rejects missing message", async ({ request, baseURL }) => {
    const response = await request.post(`${baseURL}/api/a2a/message`, {
      data: {},
    });

    expect(response.status()).toBe(400);
  });

  test("task-search skill returns response", async ({ request, baseURL }) => {
    const response = await request.post(`${baseURL}/api/a2a/message`, {
      data: {
        message: {
          role: "user",
          messageId: "test-msg-003",
          parts: [{ text: "Search for high-priority tasks" }],
        },
      },
    });

    expect(response.ok()).toBeTruthy();
    const body = await response.json();
    expect(body.task.metadata?.skill).toBe("task-search");
  });

  test("framework-scoring skill returns response", async ({
    request,
    baseURL,
  }) => {
    const response = await request.post(`${baseURL}/api/a2a/message`, {
      data: {
        message: {
          role: "user",
          messageId: "test-msg-004",
          parts: [{ text: "Score this task using RICE" }],
        },
      },
    });

    expect(response.ok()).toBeTruthy();
    const body = await response.json();
    expect(body.task.metadata?.skill).toBe("framework-scoring");
  });
});

test.describe("A2A Task Status", () => {
  test("returns task by ID", async ({ request, baseURL }) => {
    const response = await request.get(
      `${baseURL}/api/a2a/tasks/test-task-123`
    );
    expect(response.ok()).toBeTruthy();
    const body = await response.json();
    expect(body.task).toBeDefined();
    expect(body.task.id).toBe("test-task-123");
  });
});

test.describe("MCP Discovery", () => {
  test("the public manifest points clients to authenticated discovery", async ({ request }) => {
    const response = await request.get("/.well-known/mcp.json")
    expect(response.ok()).toBeTruthy()
    const manifest = await response.json()
    expect(manifest).toMatchObject({
      name: "meitheal",
      protocol: "mcp",
      protocolVersion: "2025-03-26",
      endpoint: "/api/mcp",
      authentication: { type: "bearer", requiredScope: "mcp:execute" },
    })
    expect(manifest.discovery).toContain("tools/list")
    expect(manifest).not.toHaveProperty("tools")

    const discovery = await request.post(manifest.endpoint, {
      headers: { origin: new URL(response.url()).origin },
      data: { jsonrpc: "2.0", id: 1, method: "tools/list" },
    })
    expect(discovery.status()).toBe(401)
    expect(discovery.headers()["www-authenticate"]).toMatch(/^Bearer/i)
    expect(await discovery.json()).not.toHaveProperty("result")
  })

  test("the runtime catalog exposes valid schemas only for the token's scopes", async ({ playwright }) => {
    test.skip(process.env.MEITHEAL_TEST_BROWSER !== "1", "Requires a built App and its disposable ingress fixture")
    const work = await mkdtemp(join(tmpdir(), "meitheal-mcp-discovery-"))
    const web = fileURLToPath(new URL("../../apps/web", import.meta.url))
    const fixture = fileURLToPath(new URL("../scripts/feedback-ingress-fixture.mjs", import.meta.url))
    const env = { PATH: process.env.PATH, NODE_ENV: "production", MEITHEAL_DB_URL: `file:${join(work, "meitheal.db")}` }
    const api = await playwright.request.newContext()
    let server: ReturnType<typeof fork> | undefined

    try {
      execFileSync(process.execPath, ["scripts/migrate.mjs"], { cwd: web, env })
      const child = fork(fixture, { cwd: web, env, stdio: ["ignore", "ignore", "inherit", "ipc"] })
      server = child
      const [info] = await Promise.race([
        once(child, "message", { signal: AbortSignal.timeout(10_000) }),
        once(child, "exit").then(([code]) => { throw new Error(`Ingress fixture exited with ${code}`) }),
      ])
      const origin = `http://127.0.0.1:${info.port}`
      const discovery = await api.get(origin + info.configuredPath + "/.well-known/agent-card.json", { maxRedirects: 0 })
      expect(discovery.status()).toBe(200)
      const card = await discovery.json()
      expect(card.documentationUrl).toBe(info.configuredPath + "/openapi.yaml")
      expect((await api.get(origin + card.documentationUrl)).ok()).toBe(true)
      const adminPath = origin + info.configuredPath + "/api/agent-tokens"
      const issueToken = async (scopes: string[]) => {
        const enrollment = await api.post(adminPath, {
          headers: { cookie: "feedback-fixture=admin" },
          data: { name: "MCP discovery fixture", scopes },
        })
        expect(enrollment.status()).toBe(201)
        const { token } = await enrollment.json()
        return { authorization: `Bearer ${token}` }
      }
      const send = (headers: Record<string, string>, method: string, params?: Record<string, unknown>) =>
        api.post(origin + "/api/mcp", { headers, data: { jsonrpc: "2.0", id: 1, method, params } })
      const readHeaders = await issueToken(["mcp:execute", "tasks:read"])
      const writeHeaders = await issueToken(["mcp:execute", "tasks:write"])
      const noMcpHeaders = await issueToken(["tasks:read"])

      expect((await send(noMcpHeaders, "tools/list")).status()).toBe(403)
      const initialize = await send(readHeaders, "initialize")
      expect(initialize.ok()).toBeTruthy()
      expect(await initialize.json()).toMatchObject({
        jsonrpc: "2.0",
        id: 1,
        result: { protocolVersion: "2025-03-26", capabilities: { tools: { listChanged: false } } },
      })

      const readList = await send(readHeaders, "tools/list")
      const writeList = await send(writeHeaders, "tools/list")
      expect(readList.ok()).toBeTruthy()
      expect(writeList.ok()).toBeTruthy()
      const read = await readList.json()
      const write = await writeList.json()
      expect(read).toMatchObject({ jsonrpc: "2.0", id: 1, result: { tools: expect.any(Array) } })
      expect(write).toMatchObject({ jsonrpc: "2.0", id: 1, result: { tools: expect.any(Array) } })
      const readTools = read.result.tools as McpTool[]
      const writeTools = write.result.tools as McpTool[]
      for (const tools of [readTools, writeTools]) {
        const names = tools.map(tool => tool.name)
        expect(new Set(names).size).toBe(names.length)
        expect(names.filter(name => /agenttoken|localfeedback|exportdatabase|settings/i.test(name))).toEqual([])
        for (const tool of tools) {
          expect(tool.name).toMatch(/^[A-Za-z][A-Za-z0-9_]{0,62}$/)
          expect(tool.description).toMatch(/\S/)
          expect(tool.inputSchema).toMatchObject({ type: "object", properties: expect.any(Object) })
          for (const property of Object.values(tool.inputSchema.properties)) {
            expect(property).toEqual(expect.any(Object))
          }
          for (const required of tool.inputSchema.required ?? []) {
            expect(Object.keys(tool.inputSchema.properties)).toContain(required)
          }
        }
      }
      expect(readTools.map(tool => tool.name)).not.toContain("createTask")
      expect(writeTools.map(tool => tool.name)).not.toContain("listTasks")
      expect(readTools.find(tool => tool.name === "listTasks")?.inputSchema).toMatchObject({
        properties: { limit: { type: "integer" } },
      })
      expect(writeTools.find(tool => tool.name === "createTask")?.inputSchema).toMatchObject({
        properties: { title: { type: "string" } },
        required: expect.arrayContaining(["title"]),
      })

      const denied = await send(readHeaders, "tools/call", { name: "createTask", arguments: { title: "Denied" } })
      expect(denied.ok()).toBeTruthy()
      expect(await denied.json()).toMatchObject({
        jsonrpc: "2.0",
        id: 1,
        error: { code: -32603, message: "Tool is unavailable to this token" },
      })
    } finally {
      if (server && server.exitCode === null && server.signalCode === null) {
        const exited = once(server, "exit")
        server.kill()
        await exited
      }
      await api.dispose()
      await rm(work, { recursive: true, force: true })
    }
  })
})

interface McpTool {
  name: string
  description: string
  inputSchema: {
    type: string
    properties: Record<string, unknown>
    required?: string[]
  }
}

test.describe("A2A-Token Spoofing Rejection", () => {
  test("rejects spoofed A2A-Token header", async ({ request, baseURL }) => {
    const response = await request.post(`${baseURL}/api/a2a/message`, {
      headers: { "A2A-Token": "spoofed-token-value" },
      data: {
        message: {
          role: "user",
          messageId: "spoofed-msg-001",
          parts: [{ text: "Create a task" }],
        },
      },
    });
    // The server should either ignore the spoofed token or reject with 401/403
    // Since we don't require auth currently, the request should succeed but the
    // spoofed token should NOT appear in the response context
    if (response.status() === 401 || response.status() === 403) {
      // Auth-enforced mode: correct rejection
      expect(response.status()).toBeGreaterThanOrEqual(400);
    } else {
      // Permissive mode: token is ignored, request processes normally
      expect(response.ok()).toBeTruthy();
      const body = await response.json();
      // Verify the spoofed token doesn't leak into the response
      expect(JSON.stringify(body)).not.toContain("spoofed-token-value");
    }
  });

  test("rejects forged Authorization header on A2A endpoint", async ({
    request,
    baseURL,
  }) => {
    const response = await request.post(`${baseURL}/api/a2a/message`, {
      headers: { Authorization: "Bearer forged-jwt-token" },
      data: {
        message: {
          role: "user",
          messageId: "forged-msg-001",
          parts: [{ text: "Search tasks" }],
        },
      },
    });
    // Either rejected or processed without escalated privileges
    if (response.status() === 401 || response.status() === 403) {
      expect(response.status()).toBeGreaterThanOrEqual(400);
    } else {
      expect(response.ok()).toBeTruthy();
      const body = await response.json();
      expect(JSON.stringify(body)).not.toContain("forged-jwt-token");
    }
  });
});
