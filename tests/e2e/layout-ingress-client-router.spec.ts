import { expect, test } from "@playwright/test";

test("Layout disables ClientRouter when behindIngress is true", async () => {
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const layoutPath = path.resolve(
    path.dirname(new URL(import.meta.url).pathname),
    "../../apps/web/src/layouts/Layout.astro"
  );
  const content = await fs.readFile(layoutPath, "utf-8");

  expect(content).toContain("behindIngress = false");
  expect(content).toContain("{!behindIngress && <ClientRouter fallback=\"swap\" />}");
});
