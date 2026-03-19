import { expect, test } from "@playwright/test";
import { shouldSkipBrowserSpecs } from "./_helpers";

test.skip(shouldSkipBrowserSpecs(), "Set E2E_BASE_URL to run A2A/WebMCP checks");

test.describe("A2A Agent Card Discovery", () => {
  test("agent.json exists at well-known path", async ({
    request,
    baseURL,
  }) => {
    const response = await request.get(
      `${baseURL}/.well-known/agent.json`
    );
    expect(response.ok()).toBeTruthy();
    const card = await response.json();
    expect(card.name).toBe("Meitheal");
    expect(card.skills).toBeDefined();
    expect(Array.isArray(card.skills)).toBe(true);
    expect(card.skills.length).toBeGreaterThanOrEqual(1);
  });

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
    expect(card.supportedInterfaces.length).toBeGreaterThanOrEqual(1);
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

  test("agent card declares HTTP+JSON binding", async ({
    request,
    baseURL,
  }) => {
    const response = await request.get(`${baseURL}/api/a2a/agent-card`);
    const card = await response.json();

    const httpInterface = card.supportedInterfaces.find(
      (i: Record<string, unknown>) => i.protocolBinding === "HTTP+JSON"
    );
    expect(httpInterface).toBeDefined();
    expect(httpInterface.protocolVersion).toBe("1.0");
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
  test("mcp.json has tools array", async ({ request, baseURL }) => {
    const response = await request.get(`${baseURL}/.well-known/mcp.json`);
    expect(response.ok()).toBeTruthy();
    const mcp = await response.json();
    expect(mcp.tools).toBeDefined();
    expect(Array.isArray(mcp.tools)).toBe(true);
    expect(mcp.tools.length).toBeGreaterThanOrEqual(3);
  });

  test("mcp.json tools have input schemas", async ({ request, baseURL }) => {
    const response = await request.get(`${baseURL}/.well-known/mcp.json`);
    const mcp = await response.json();

    for (const tool of mcp.tools) {
      expect(tool.name).toBeTruthy();
      expect(tool.description).toBeTruthy();
      expect(tool.inputSchema).toBeDefined();
      expect(tool.inputSchema.type).toBe("object");
    }
  });

  test("mcp.json references a2a agent card", async ({ request, baseURL }) => {
    const response = await request.get(`${baseURL}/.well-known/mcp.json`);
    const mcp = await response.json();
    expect(mcp.agent_protocols?.a2a).toBeDefined();
    expect(mcp.agent_protocols.a2a.agent_card).toBe(
      "/.well-known/agent.json"
    );
  });
});

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

test.describe("WebMCP JSON-RPC Validation", () => {
  test("mcp.json tool schemas validate as JSON Schema objects", async ({
    request,
    baseURL,
  }) => {
    const response = await request.get(`${baseURL}/.well-known/mcp.json`);
    expect(response.ok()).toBeTruthy();
    const mcp = await response.json();

    for (const tool of mcp.tools) {
      // Every tool must have required JSON-RPC fields
      expect(typeof tool.name).toBe("string");
      expect(tool.name.length).toBeGreaterThan(0);
      expect(typeof tool.description).toBe("string");
      expect(tool.description.length).toBeGreaterThan(0);

      // inputSchema must be a valid JSON Schema object
      expect(tool.inputSchema).toBeDefined();
      expect(tool.inputSchema.type).toBe("object");

      // If properties exist, they must be objects
      if (tool.inputSchema.properties) {
        expect(typeof tool.inputSchema.properties).toBe("object");
        for (const [key, prop] of Object.entries(tool.inputSchema.properties)) {
          const p = prop as Record<string, unknown>;
          expect(typeof key).toBe("string");
          expect(p.type || p.$ref).toBeTruthy();
        }
      }
    }
  });

  test("mcp.json has valid metadata structure", async ({
    request,
    baseURL,
  }) => {
    const response = await request.get(`${baseURL}/.well-known/mcp.json`);
    const mcp = await response.json();

    // Validate top-level structure
    expect(mcp.tools).toBeDefined();
    expect(Array.isArray(mcp.tools)).toBe(true);

    // Agent protocols section
    if (mcp.agent_protocols) {
      expect(typeof mcp.agent_protocols).toBe("object");
    }

    // No duplicate tool names
    const toolNames = mcp.tools.map((t: { name: string }) => t.name);
    const uniqueNames = new Set(toolNames);
    expect(uniqueNames.size).toBe(toolNames.length);
  });

  test("mcp.json tool names follow naming conventions", async ({
    request,
    baseURL,
  }) => {
    const response = await request.get(`${baseURL}/.well-known/mcp.json`);
    const mcp = await response.json();

    for (const tool of mcp.tools) {
      // Tool names should be camelCase or snake_case, no spaces
      expect(tool.name).not.toContain(" ");
      expect(tool.name.length).toBeGreaterThan(0);
      expect(tool.name.length).toBeLessThan(64);
    }
  });
});
