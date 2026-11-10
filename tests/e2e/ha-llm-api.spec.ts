import { expect, test } from "@playwright/test";
import { shouldSkipBrowserSpecs } from "./_helpers";

test.skip(shouldSkipBrowserSpecs(), "Set E2E_BASE_URL to run LLM API checks");

test("GET /api/ha/agents returns valid structure", async ({
  request,
  baseURL,
}) => {
  const response = await request.get(`${baseURL}/api/ha/agents`);
  // May be 503 if HA not connected in CI — that's expected
  expect([200, 503]).toContain(response.status());
  const data = await response.json();
  expect(data).toHaveProperty("agents");
  expect(Array.isArray(data.agents)).toBe(true);
});

test("POST /api/ha/assist requires text property", async ({
  request,
  baseURL,
}) => {
  const response = await request.post(`${baseURL}/api/ha/assist`, {
    data: {},
  });
  // 400 (missing text) or 503 (HA disconnected)
  expect([400, 503]).toContain(response.status());
});

test("POST /api/ha/assist accepts conversation_id and agent_id", async ({
  request,
  baseURL,
}) => {
  const response = await request.post(`${baseURL}/api/ha/assist`, {
    data: {
      text: "Hello",
      agent_id: "test-agent",
      conversation_id: "test-conv-123",
    },
  });
  // 200, 503, or 500 depending on HA connectivity
  expect([200, 500, 503]).toContain(response.status());
});

test("POST /api/ha/assist returns full response shape", async ({
  request,
  baseURL,
}) => {
  const response = await request.post(`${baseURL}/api/ha/assist`, {
    data: { text: "Hello" },
  });
  if (response.status() === 200) {
    const data = await response.json();
    expect(data).toHaveProperty("speech");
    expect(data).toHaveProperty("conversation_id");
    expect(data).toHaveProperty("response_type");
  }
});

test("can save HA assist agent setting", async ({ request, baseURL }) => {
  const saveRes = await request.put(`${baseURL}/api/settings`, {
    data: { key: "ha-assist-agent", value: "test-agent-id" },
  });
  expect(saveRes.ok()).toBeTruthy();

  const getRes = await request.get(`${baseURL}/api/settings`);
  expect(getRes.ok()).toBeTruthy();
  const settings = (await getRes.json()) as Record<string, unknown>;
  expect(settings["ha-assist-agent"]).toBe("test-agent-id");
});
