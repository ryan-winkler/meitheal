import { expect, test } from "@playwright/test";

const TEXT_EXTENSIONS = new Set([
  ".ts", ".astro", ".md", ".py", ".yaml", ".yml", ".txt", ".river", ".sh", ".json",
]);

async function walkFiles(root: string): Promise<string[]> {
  const fs = await import("node:fs/promises");
  const path = await import("node:path");

  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      if (!TEXT_EXTENSIONS.has(path.extname(entry.name))) continue;
      out.push(full);
    }
  }

  await walk(root);
  return out;
}

test("rename sweep keeps legacy meitheal_hub references only where explicitly allowed", async () => {
  const fs = await import("node:fs/promises");
  const path = await import("node:path");

  const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
  const scanRoots = [
    path.join(repoRoot, "apps/web/src"),
    path.join(repoRoot, "integrations/home-assistant/custom_components/meitheal"),
    path.join(repoRoot, "meitheal-hub"),
    path.join(repoRoot, "docs"),
  ];

  const allowedLegacyHostFiles = new Set([
    path.join(repoRoot, "integrations/home-assistant/custom_components/meitheal/const.py"),
    // DeviceInfo identifiers — meitheal_hub is the HA device slug, not deprecated
    path.join(repoRoot, "integrations/home-assistant/custom_components/meitheal/__init__.py"),
    path.join(repoRoot, "integrations/home-assistant/custom_components/meitheal/helpers.py"),
    path.join(repoRoot, "docs/kcs/troubleshooting.md"),
  ]);

  const violations: string[] = [];

  for (const root of scanRoots) {
    const files = await walkFiles(root);
    for (const filePath of files) {
      const content = await fs.readFile(filePath, "utf-8");
      const lines = content.split("\n");

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? "";
        if (line.includes("coolockvillage/meitheal-hub-")) {
          violations.push(`${filePath}:${i + 1} contains deprecated image name`);
        }
        if (line.includes("/meitheal_hub/")) {
          violations.push(`${filePath}:${i + 1} contains deprecated panel URI`);
        }
        if (line.includes("meitheal_hub")) {
          // Whitelisted files can contain meitheal_hub (DeviceInfo identifiers, constants)
          if (!allowedLegacyHostFiles.has(filePath)) {
            violations.push(`${filePath}:${i + 1} contains unexpected meitheal_hub reference`);
          }
        }
      }
    }
  }

  expect(violations).toEqual([]);
});
