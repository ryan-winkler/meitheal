import { expect, test } from "@playwright/test";
import { shouldSkipBrowserSpecs } from "./_helpers";

test.skip(shouldSkipBrowserSpecs(), "Set E2E_BASE_URL to run settings checks");

test.describe("Agent Protocol Settings", () => {
  test("can save A2A enabled setting", async ({ request, baseURL }) => {
    // Save setting
    const saveRes = await request.put(`${baseURL}/api/settings`, {
      data: { key: "agent-protocols-a2a-enabled", value: true },
    });
    expect(saveRes.ok()).toBeTruthy();

    // Verify persisted
    const getRes = await request.get(`${baseURL}/api/settings`);
    expect(getRes.ok()).toBeTruthy();
    const settings = (await getRes.json()) as Record<string, unknown>;
    expect(settings["agent-protocols-a2a-enabled"]).toBe(true);
  });

  test("can save WebMCP enabled setting", async ({ request, baseURL }) => {
    const saveRes = await request.put(`${baseURL}/api/settings`, {
      data: { key: "agent-protocols-webmcp-enabled", value: false },
    });
    expect(saveRes.ok()).toBeTruthy();

    const getRes = await request.get(`${baseURL}/api/settings`);
    const settings = (await getRes.json()) as Record<string, unknown>;
    expect(settings["agent-protocols-webmcp-enabled"]).toBe(false);
  });

  test("can save MCP enabled setting", async ({ request, baseURL }) => {
    const saveRes = await request.put(`${baseURL}/api/settings`, {
      data: { key: "agent-protocols-mcp-enabled", value: true },
    });
    expect(saveRes.ok()).toBeTruthy();

    const getRes = await request.get(`${baseURL}/api/settings`);
    const settings = (await getRes.json()) as Record<string, unknown>;
    expect(settings["agent-protocols-mcp-enabled"]).toBe(true);
  });

  test("agent card responds based on A2A setting", async ({
    request,
    baseURL,
  }) => {
    // Enable A2A
    await request.put(`${baseURL}/api/settings`, {
      data: { key: "agent-protocols-a2a-enabled", value: true },
    });

    // Agent card should be available
    const enabledRes = await request.get(`${baseURL}/api/a2a/agent-card`);
    expect(enabledRes.ok()).toBeTruthy();
  });
});
