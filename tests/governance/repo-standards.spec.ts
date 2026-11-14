import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { test, expect } from "@playwright/test";

const repoRoot = join(process.cwd(), "..");
const addonRoot = join(repoRoot, "meitheal-hub");

const requiredFiles = [
  "README.md",
  "AGENTS.md",
  "WEBMCP.md",
  "SECURITY.md",
  "CONTRIBUTING.md",
  "CODE_OF_CONDUCT.md",
  "SUPPORT.md",
  "COMMERCIAL.md",
  "repository.yaml",
  ".coderabbit.yaml",
  "meitheal-hub/README.md",
  "meitheal-hub/DOCS.md",
  "meitheal-hub/config.yaml",
  "docs/decisions/0001-legal-and-naming-strategy.md",
  "docs/decisions/0002-target-architecture.md",
  "docs/index.md",
  "docs/kcs/home-assistant-devcontainer.md",
  "docs/kcs/operations-runbook.md",
  "public/.well-known/mcp.json",
  "public/.well-known/jsondoc.json"
];

test("required governance files exist", () => {
  for (const file of requiredFiles) {
    expect(existsSync(join(repoRoot, file)), `Missing ${file}`).toBeTruthy();
  }
});

test("repository guidance covers Astro, Home Assistant, and domain boundaries", () => {
  const guidance = readFileSync(join(repoRoot, "AGENTS.md"), "utf8");
  expect(guidance).toContain("Astro-first");
  expect(guidance).toContain("Home Assistant");
  expect(guidance).toContain("DDD");
});

test("addon config includes publishing image contract", () => {
  const addonConfig = readFileSync(join(addonRoot, "config.yaml"), "utf8");
  expect(addonConfig).toContain("image:");
  expect(addonConfig).toContain("{arch}");
});

test("repository metadata keeps Home Assistant publishing fields", () => {
  const repositoryConfig = readFileSync(join(repoRoot, "repository.yaml"), "utf8");
  expect(repositoryConfig).toMatch(/^name:\s*".+"/m);
  expect(repositoryConfig).toMatch(
    /^url:\s*"https:\/\/github\.com\/ryan-winkler\/meitheal-ha-addon"/m,
  );

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

  // monorepo root package.json must also agree
  const rootPkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
  expect(rootPkg.version, "package.json version must match config.yaml").toBe(configVersion);
});

test("branching and SemVer guardrails require dev-only auto-push and 0.0.{digit} steps", () => {
  const guidance = readFileSync(join(repoRoot, "AGENTS.md"), "utf8");
  expect(guidance).toContain("Only automatically push to `dev`");
  expect(guidance).toContain("`main` | Beta channel (mostly unused)");
  expect(guidance).toContain("`release` | Full production release");
  expect(guidance).toContain("0.0.{one digit}");

  const syncResult = spawnSync(process.execPath, ["scripts/check-version-sync.mjs"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  expect(syncResult.status, syncResult.stderr).toBe(0);

  for (const rejected of ["minor", "major", "0.0.5", "0.0.10"]) {
    const bumpResult = spawnSync(process.execPath, ["scripts/bump-version.mjs", rejected], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    expect(bumpResult.status, `Expected rejection for ${rejected}`).toBe(1);
    expect(bumpResult.stderr).toContain("--force-semver");
  }
});

function listFilesRecursive(dir: string, exts: string[]): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile() && exts.some(ext => entry.name.endsWith(ext)))
    .map(entry => join(entry.parentPath, entry.name))
    .sort();
}

test("DDD domain packages remain free of runtime dependencies and adapter imports", () => {
  const packagesDir = join(repoRoot, "packages");
  const domainDirs = readdirSync(packagesDir, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && entry.name.startsWith("domain-"))
    .map(entry => join(packagesDir, entry.name))
    .sort();

  expect(domainDirs.length).toBeGreaterThanOrEqual(4);

  for (const domainDir of domainDirs) {
    const pkgJson = JSON.parse(readFileSync(join(domainDir, "package.json"), "utf8")) as {
      name: string;
      dependencies?: Record<string, string>;
    };
    expect(Object.keys(pkgJson.dependencies ?? {}), `${pkgJson.name} runtime dependencies`).toEqual([]);

    const srcDir = join(domainDir, "src");
    for (const file of listFilesRecursive(srcDir, [".ts"])) {
      const content = readFileSync(file, "utf8");
      const rel = relative(repoRoot, file).replace(/\\/g, "/");
      expect(content, `${rel} must not import apps/web`).not.toMatch(
        /(?:from\s+|import\s*\(|require\s*\()[^"'\n]*["'][^"']*apps\/web\//,
      );
      expect(content, `${rel} must not import node:sqlite`).not.toMatch(/["']node:sqlite["']/);
      expect(content, `${rel} must not import @libsql/*`).not.toMatch(/["']@libsql\//);
      expect(content, `${rel} must not import home-assistant-js-websocket`).not.toMatch(
        /["']home-assistant-js-websocket["']/,
      );
    }
  }
});

test("cross-domain tasks persistence imports stay within the frozen 20-file legacy allowlist", () => {
  const allowlist = new Set([
    "auth/agent-token-store.ts",
    "calendar/calendar-bridge.ts",
    "calendar/resolve-calendar-entities.ts",
    "gamification/achievement-engine.ts",
    "gamification/streak-tracker.ts",
    "grocy/grocy-bridge.ts",
    "ha/ha-connection.ts",
    "ha/ha-startup.ts",
    "habits/habit-service.ts",
    "notifications/due-date-reminders.ts",
    "pillars/pillar-association-service.ts",
    "pillars/pillar-service.ts",
    "pillars/principle-service.ts",
    "pomodoro/pomodoro-service.ts",
    "search/search-service.ts",
    "strategy/custom-framework-repository.ts",
    "strategy/framework-repository.ts",
    "strategy/rule-repository.ts",
    "todo/todo-bridge.ts",
    "todo/todo-inbound-update.ts",
  ]);
  expect(allowlist.size).toBe(20);

  const domainsRoot = join(repoRoot, "apps/web/src/domains");
  const unauthorized: string[] = [];

  for (const file of listFilesRecursive(domainsRoot, [".ts"])) {
    const rel = relative(domainsRoot, file).replace(/\\/g, "/");
    if (rel.startsWith("tasks/")) continue;
    const content = readFileSync(file, "utf8");
    const importsTaskPersistence =
      /@domains\/tasks\/persistence/.test(content) ||
      /(?:from|import)\s*["'](?:\.\.\/)+tasks\/persistence/.test(content);
    if (importsTaskPersistence && !allowlist.has(rel)) {
      unauthorized.push(rel);
    }
  }

  expect(unauthorized).toEqual([]);
});

test("precompiled MCP catalog and 64-icon Tabler registry match build generators with zero drift", () => {
  const verifyResult = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
        import { readFileSync } from "node:fs";
        import { buildMcpCatalogFromYaml } from "./apps/web/scripts/generate-mcp-tools.mjs";
        import { CANONICAL_TABLER_ICONS, generateIconRegistrySource } from "./apps/web/scripts/generate-icons.mjs";

        const openapi = readFileSync("./apps/web/public/openapi.yaml", "utf8");
        const expectedMcp = JSON.stringify(buildMcpCatalogFromYaml(openapi), null, 2) + "\\n";
        const actualMcp = readFileSync("./apps/web/src/generated/mcp-tools.json", "utf8");
        if (expectedMcp !== actualMcp) {
          console.error("MCP catalog drift detected");
          process.exit(2);
        }

        if (CANONICAL_TABLER_ICONS.length !== 64 || new Set(CANONICAL_TABLER_ICONS).size !== 64) {
          console.error("Expected 64 canonical Tabler icons");
          process.exit(3);
        }
        const expectedIcons = generateIconRegistrySource();
        const actualIcons = readFileSync("./apps/web/src/generated/icon-registry.ts", "utf8");
        if (expectedIcons !== actualIcons) {
          console.error("Icon registry drift detected");
          process.exit(4);
        }
      `,
    ],
    { cwd: repoRoot, encoding: "utf8" },
  );
  expect(verifyResult.status, verifyResult.stderr).toBe(0);
});

test("Evergreen Carbon surface rules, indigo chrome allowlist, and Bucket 2 option strings hold", () => {
  const webSrcRoot = join(repoRoot, "apps/web/src");
  const indigoAllowlist = new Set([
    "lib/design-tokens.ts",
    "components/ui/ColorPicker.astro",
    "domains/labels/label-color-resolver.ts",
    "domains/habits/habit-service.ts",
    "domains/pillars/pillar-service.ts",
    "domains/tasks/persistence/hierarchy-repository.ts",
    "domains/tasks/persistence/store.ts",
    "domains/tasks/persistence/task-repository.ts",
    "pages/api/areas/index.ts",
    "pages/api/projects/index.ts",
    "pages/api/tasks/[id].ts",
    "pages/api/users/custom.ts",
    "pages/api/users/index.ts",
  ]);
  expect(indigoAllowlist.size).toBe(13);

  const blurViolations: string[] = [];
  const indigoViolations: string[] = [];

  for (const file of listFilesRecursive(webSrcRoot, [".css", ".astro", ".ts", ".tsx", ".mjs"])) {
    const rel = relative(webSrcRoot, file).replace(/\\/g, "/");
    const content = readFileSync(file, "utf8");

    if (/backdrop-filter|backdrop-blur-/.test(content)) {
      blurViolations.push(rel);
    }
    if (!indigoAllowlist.has(rel) && /#6366f1|#7c3aed/i.test(content)) {
      indigoViolations.push(rel);
    }
  }

  expect(blurViolations, "files with backdrop-filter or backdrop-blur-*").toEqual([]);
  expect(indigoViolations, "files with unauthorized #6366f1/#7c3aed chrome literals").toEqual([]);

  const enRaw = readFileSync(join(webSrcRoot, "i18n/en.json"), "utf8");
  const gaRaw = readFileSync(join(webSrcRoot, "i18n/ga.json"), "utf8");
  expect(enRaw).toContain('"settings.cal_sync_bidirectional": "↔');
  expect(gaRaw).toContain('"settings.cal_sync_bidirectional": "↔');

  const fwWizard = readFileSync(join(webSrcRoot, "components/settings/FrameworkWizard.astro"), "utf8");
  expect(fwWizard).toContain('<option value="danger">🔴 Red (Urgent)</option>');
  expect(fwWizard).toContain('<option value="accent">🟡 Accent</option>');
  expect(fwWizard).toContain('<option value="bg-secondary">⚪ Neutral</option>');
  expect(fwWizard).toContain('<option value="bg-primary">🔵 Primary</option>');
});
