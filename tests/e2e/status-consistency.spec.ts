import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { expect, test } from "@playwright/test"
import { CANONICAL_STATUSES } from "../../apps/web/src/lib/status-config"

/**
 * E2E: Status Consistency
 *
 * Ensures no legacy task status values appear outside compatibility code.
 * Other bounded contexts can define their own workflow states.
 * This test acts as a guardrail to prevent regression.
 */

// Source directories to scan
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SRC_DIR = path.resolve(__dirname, "../../apps/web/src");

// Patterns that indicate a hardcoded legacy status value in code
// Each pattern is [regex, description]
const LEGACY_PATTERNS: [RegExp, string][] = [
  // String literals with legacy status values
  [/['"]todo['"]/, "hardcoded 'todo' string literal"],
  [/['"]in_progress['"]/, "hardcoded 'in_progress' string literal"],
  [/['"]done['"]/, "hardcoded 'done' string literal"],
];

// Files/patterns that are allowed to reference legacy statuses
// (mapper files, migration code, test files, backward compat)
const ALLOWED_FILES = [
  "todo-status-mapper.ts",          // The canonical mapper itself
  "status-config.ts",               // Legacy alias definitions
  "store.ts",                       // Data migration code
  "status-consistency.spec.ts",     // This test
  "todo-status-mapper.spec.ts",     // Unit tests for mapper
  "ha-entities.ts",                 // HA domain "todo" entity helpers
  "ha-services.ts",                 // HA domain "todo" service calls
  "ha-startup.ts",                  // HA domain "todo" registration
  "EntitySelector.astro",           // HA domain "todo" entity filtering
  "StatusBadge.astro",              // Legacy fallback display
  "SettingsIntegrations.astro",     // HA "todo" domain explainer
  "IntegrationTodo.astro",          // HA "todo" domain explainer (sub-component)
  "timeline.astro",                  // Legacy backward compat display
  "calendar.astro",                  // Legacy backward compat SQL fallback
  "index.astro",                     // CSS class names for styling
  "todo-bridge.ts",                  // Logger category name "todo"
  "settings-registry.ts",            // Global search keywords containing "todo"
];

// Support feedback has its own review states, including "in_progress".
const SUPPORT_STATUS_FILES = new Set([
  "components/settings/SettingsFeedback.astro",
  "domains/support/feedback-queue.ts",
  "lib/settings-feedback-controller.ts",
  "pages/api/feedback/index.ts",
  "pages/api/feedback/[id].ts",
])

function allowsNoncanonicalStatus(filePath: string): boolean {
  return ALLOWED_FILES.includes(path.basename(filePath)) ||
    SUPPORT_STATUS_FILES.has(path.relative(SRC_DIR, filePath))
}

// Lines that are allowed to reference legacy statuses (comments, alias maps)
const ALLOWED_LINE_PATTERNS = [
  /^\s*\/\//, // Comments
  /^\s*\*/, // Doc comments
  /LEGACY_ALIASES/, // The alias map itself
  /normalizeStatus/, // Normalization function
  /status === "complete" \|\| status === "done"/, // Timeline read fallback for older task rows
  /legacy|alias|fallback|backward|compat/i, // Explicit legacy handling
  /domain.*=.*['"]todo['"]/, // HA domain "todo" (not a status value)
  /domain:\s*['"]todo['"]/, // HA domain calls
  /['"]todo\./, // HA entity IDs like "todo.meitheal_tasks"
  /getEntitiesByDomain/, // HA entity helpers
  /classList\./, // CSS class manipulation (e.g. classList.add("done"))
  /class=.*done/, // CSS class names in templates
  /logApiError\(/, // API error logging with route identifiers
  /enabledCategories/, // Logger category lists
];

function getAllTsFiles(dir: string): string[] {
  const results: string[] = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory() && entry.name !== "node_modules" && entry.name !== "dist") {
      results.push(...getAllTsFiles(fullPath));
    } else if (entry.isFile() && /\.(ts|astro|js)$/.test(entry.name)) {
      results.push(fullPath);
    }
  }
  return results;
}

test.describe("Status Consistency — No Legacy Leaks", () => {

  test("canonical statuses are defined correctly", () => {
    expect(CANONICAL_STATUSES).toEqual(["backlog", "pending", "active", "complete"]);
    expect(CANONICAL_STATUSES.length).toBe(4);
  });

  test("no hardcoded legacy status values in source files", () => {
    const violations: string[] = [];
    const files = getAllTsFiles(SRC_DIR);

    for (const filePath of files) {
      if (allowsNoncanonicalStatus(filePath)) continue

      const content = fs.readFileSync(filePath, "utf-8");
      const lines = content.split("\n");

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;

        // Skip allowed line patterns
        if (ALLOWED_LINE_PATTERNS.some((p) => p.test(line))) continue;

        for (const [pattern, desc] of LEGACY_PATTERNS) {
          if (pattern.test(line)) {
            const relPath = path.relative(SRC_DIR, filePath);
            violations.push(`${relPath}:${i + 1} — ${desc}: ${line.trim().slice(0, 80)}`);
          }
        }
      }
    }

    if (violations.length > 0) {
      const msg = [
        `Found ${violations.length} legacy status reference(s) in source:`,
        "",
        ...violations.slice(0, 20),
        violations.length > 20 ? `... and ${violations.length - 20} more` : "",
      ].join("\n");
      expect(violations, msg).toHaveLength(0);
    }
  });

  test("SQL queries use only canonical status values", () => {
    const violations: string[] = [];
    const files = getAllTsFiles(SRC_DIR);

    // Patterns for SQL with legacy statuses
    const sqlLegacyPatterns = [
      /\bstatus\s+(?:NOT\s+)?IN\s*\([^)]*['"](?:todo|in_progress|done)['"]/i,
      /\bstatus\s*(?:=|!=|<>|\bIS(?:\s+NOT)?\b)\s*['"](?:todo|in_progress|done)['"]/i,
      /\bDEFAULT\s+['"](?:todo|in_progress|done)['"]/i,
    ];

    for (const filePath of files) {
      if (allowsNoncanonicalStatus(filePath)) continue

      const content = fs.readFileSync(filePath, "utf-8");
      const lines = content.split("\n");

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        if (ALLOWED_LINE_PATTERNS.some((p) => p.test(line))) continue;

        for (const pattern of sqlLegacyPatterns) {
          if (pattern.test(line)) {
            const relPath = path.relative(SRC_DIR, filePath);
            violations.push(`${relPath}:${i + 1} — SQL legacy status: ${line.trim().slice(0, 80)}`);
          }
        }
      }
    }

    if (violations.length > 0) {
      const msg = [
        `Found ${violations.length} SQL queries with legacy status values:`,
        "",
        ...violations.slice(0, 20),
      ].join("\n");
      expect(violations, msg).toHaveLength(0);
    }
  });

  test("API responses should send canonical statuses", () => {
    // Verify that API route handlers don't send legacy statuses
    const apiDir = path.join(SRC_DIR, "pages", "api");
    if (!fs.existsSync(apiDir)) return;

    const apiFiles = getAllTsFiles(apiDir);
    const violations: string[] = [];

    for (const filePath of apiFiles) {
      if (allowsNoncanonicalStatus(filePath)) continue

      const content = fs.readFileSync(filePath, "utf-8");
      const lines = content.split("\n");

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        if (ALLOWED_LINE_PATTERNS.some((p) => p.test(line))) continue;

        // Check for response body with legacy status
        if (/status:\s*['"](?:todo|in_progress|done)['"]/.test(line)) {
          const relPath = path.relative(SRC_DIR, filePath);
          violations.push(`${relPath}:${i + 1} — API response with legacy status: ${line.trim().slice(0, 80)}`);
        }
      }
    }

    if (violations.length > 0) {
      expect(violations, `API routes sending legacy statuses:\n${violations.join("\n")}`).toHaveLength(0);
    }
  });

  test("frontend checkbox handlers use canonical statuses", () => {
    // The today.astro and upcoming.astro checkbox handlers should send 'complete', not 'done'
    const pageFiles = ["today.astro", "upcoming.astro", "table.astro"];

    for (const filename of pageFiles) {
      const filePath = path.join(SRC_DIR, "pages", filename);
      if (!fs.existsSync(filePath)) continue;

      const content = fs.readFileSync(filePath, "utf-8");

      // Should NOT have status: "done" in checkbox handlers
      expect(
        content,
        `${filename} should not use "done" in checkbox handlers`,
      ).not.toMatch(/status:\s*['"]done['"]/);
    }
  });
});
