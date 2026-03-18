#!/usr/bin/env node
/**
 * validate-domain-language.mjs — CI-enforceable ubiquitous language linter
 *
 * Greps the codebase for deprecated terms that violate the DDD ubiquitous language.
 * Exit code 0 = clean, 1 = violations found.
 *
 * Usage: node scripts/validate-domain-language.mjs
 *
 * @domain observability
 * @see docs/decisions/ADR-007-hierarchy-model.md
 */

import { execSync } from "node:child_process"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, "..")

// Patterns to check — term + contexts where it's allowed
const DEPRECATED_TERMS = [
  {
    term: "is_habit",
    description: "Use 'is_routine' instead (ADR-007)",
    // Allowed in migration context, schema column additions, and this validator itself
    allowedPatterns: [
      "validate-domain-language",
      "hasColumn",
      "is_routine",
      "ADR-007",
      "persona-loops",
      "ALTER TABLE",
      "is_habit INTEGER",
      "is_habit=1",
      "dist/",
      "template-repository",
      "habits.ts",
      "habits.astro",
      "persistence/store",
    ],
  },
  {
    term: "frequency",
    // This is too generic — only flag it in specific domain contexts
    description: "Use 'cadence' instead in task_templates context (ADR-007)",
    skipCheck: true, // Too many false positives — 'frequency' is a common English word
  },
]

let violations = 0

for (const rule of DEPRECATED_TERMS) {
  if (rule.skipCheck) continue

  try {
    const cmd = `grep -rn --include="*.ts" --include="*.astro" --include="*.mjs" "${rule.term}" "${root}/apps" "${root}/packages" "${root}/scripts" 2>/dev/null || true`
    const output = execSync(cmd, { encoding: "utf-8" }).trim()

    if (!output) continue

    const lines = output.split("\n").filter(Boolean)

    for (const line of lines) {
      // Check if this match is in an allowed context
      const isAllowed = rule.allowedPatterns?.some(p => line.includes(p))
      if (isAllowed) continue

      violations++
      console.error(`❌ [${rule.term}] ${line}`)
      console.error(`   → ${rule.description}\n`)
    }
  } catch {
    // grep returns exit 1 when no matches found — that's fine
  }
}

if (violations > 0) {
  console.error(`\n🚫 Found ${violations} ubiquitous language violation(s).`)
  console.error("   See docs/decisions/ADR-007-hierarchy-model.md for correct terminology.\n")
  process.exit(1)
} else {
  console.log("✅ Ubiquitous language check passed — no deprecated terms found.")
  process.exit(0)
}
