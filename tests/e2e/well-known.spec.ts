import { expect, test } from "@playwright/test";
import { shouldSkipBrowserSpecs } from "./_helpers";

test.skip(shouldSkipBrowserSpecs(), "Set E2E_BASE_URL to run .well-known checks");

test("mcp discovery file exists", async ({ request, baseURL }) => {
  const response = await request.get(`${baseURL}/.well-known/mcp.json`);
  expect(response.ok()).toBeTruthy();
});

test("a2a agent card file exists", async ({ request, baseURL }) => {
  const response = await request.get(`${baseURL}/.well-known/agent.json`);
  expect(response.ok()).toBeTruthy();
  const card = await response.json();
  expect(card.name).toBe("Meitheal");
});
