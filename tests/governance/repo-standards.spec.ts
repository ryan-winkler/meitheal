import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test, expect } from "@playwright/test";

const repoRoot = join(process.cwd(), "..");
const addonRoot = join(repoRoot, "meitheal-hub");

const requiredFiles = [
  "README.md",
  "AGENTS.md",
  "SKILL.md",
  "WEBMCP.md",
  "SECURITY.md",
  "CONTRIBUTING.md",
  "AI_POLICY.md",
  "COMMERCIAL.md",
  "repository.yaml",
  ".coderabbit.yaml",
  ".zeroclaw/soul.md",
  ".skills/core-workflows/SKILL.md",
  "meitheal-hub/README.md",
  "meitheal-hub/DOCS.md",
  "meitheal-hub/config.yaml",
  "docs/decisions/0001-legal-and-naming-strategy.md",
  "docs/decisions/0002-target-architecture.md",
  "docs/kcs/operations-runbook.md",
  "public/.well-known/mcp.json",
  "public/.well-known/jsondoc.json"
];

test("required governance files exist", () => {
  for (const file of requiredFiles) {
    expect(existsSync(join(repoRoot, file)), `Missing ${file}`).toBeTruthy();
  }
});

test("readme enforces Astro and HA first principles", () => {
  const readme = readFileSync(join(repoRoot, "README.md"), "utf8");
  expect(readme).toContain("Astro-first");
  expect(readme).toContain("Home Assistant");
  expect(readme).toContain("DDD");
});

test("addon config includes publishing image contract", () => {
  const addonConfig = readFileSync(join(addonRoot, "config.yaml"), "utf8");
  expect(addonConfig).toContain("image:");
  expect(addonConfig).toContain("{arch}");
});

test("repository metadata keeps Home Assistant publishing fields", () => {
  const repositoryConfig = readFileSync(join(repoRoot, "repository.yaml"), "utf8");
  expect(repositoryConfig).toMatch(/^name:\s*".+"/m);
  expect(repositoryConfig).toMatch(/^url:\s*"https:\/\/github\.com\/Coolock-Village\/meitheal"/m);

  const maintainer = repositoryConfig.match(/^maintainer:\s*"([^"]+)"/m)?.[1] ?? "";
  expect(maintainer).toMatch(/^[^<]+<[^@\s]+@[^>\s]+>$/);
});

test("version consistency — config.yaml, run.sh, and sw.js must agree", () => {
  // config.yaml is the single source of truth
  const configYaml = readFileSync(join(addonRoot, "config.yaml"), "utf8");
  const configVersion = configYaml.match(/^version:\s*["']?([^"'\n]+)["']?/m)?.[1];
  expect(configVersion, "config.yaml must have a version").toBeTruthy();

  // run.sh must export the same version
  const runSh = readFileSync(join(addonRoot, "run.sh"), "utf8");
  const runVersion = runSh.match(/MEITHEAL_VERSION="([^"]+)"/)?.[1];
  expect(runVersion, "run.sh MEITHEAL_VERSION must match config.yaml").toBe(configVersion);

  // sw.js hardcoded fallback should not be older than config.yaml
  const swJs = readFileSync(join(repoRoot, "apps/web/public/sw.js"), "utf8");
  const swVersion = swJs.match(/CACHE_VERSION\s*=\s*"([^"]+)"/)?.[1];
  expect(swVersion, "sw.js CACHE_VERSION must match config.yaml").toBe(configVersion);
});
