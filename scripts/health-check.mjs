#!/usr/bin/env node
/**
 * health-check.mjs — Phase 29 T13 codebase health metrics
 *
 * Scans src/lib/ and src/components/ for common quality signals.
 * Run: node scripts/health-check.mjs
 *
 * @kcs Phase 29 tooling — visibility into listener hygiene, innerHTML, etc.
 */

import { execSync } from "node:child_process"
import { resolve, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = resolve(__dirname, "..", "apps", "web", "src")

function count(pattern, paths = "lib/ components/", flags = "") {
  try {
    const cmd = `grep -rn ${flags} '${pattern}' ${paths} --include='*.ts' --include='*.astro' | wc -l`
    return Number(execSync(cmd, { cwd: root, encoding: "utf8" }).trim())
  } catch {
    return 0
  }
}

function countWithout(pattern, exclude, paths = "lib/ components/") {
  try {
    const cmd = `grep -rn '${pattern}' ${paths} --include='*.ts' --include='*.astro' | grep -v '${exclude}' | wc -l`
    return Number(execSync(cmd, { cwd: root, encoding: "utf8" }).trim())
  } catch {
    return 0
  }
}

console.log("\n🏥 Meitheal Codebase Health Check\n")
console.log("─".repeat(50))

// Listener hygiene
const totalListeners = count("addEventListener")
const signalListeners = count("addEventListener.*signal")
const bareListeners = totalListeners - signalListeners
const signalPct = totalListeners > 0 ? ((signalListeners / totalListeners) * 100).toFixed(1) : "N/A"

console.log(`\n📡 Event Listeners`)
console.log(`   Total addEventListener:     ${totalListeners}`)
console.log(`   With { signal }:            ${signalListeners} (${signalPct}%)`)
console.log(`   Without signal:             ${bareListeners}`)

// innerHTML
const totalInnerHTML = count("innerHTML\\s*=")
const safeInnerHTML = count("innerHTML.*escapeHtml")
const emptyInnerHTML = count('innerHTML\\s*=\\s*["`]\\s*["`]')
const unsafeInnerHTML = totalInnerHTML - safeInnerHTML - emptyInnerHTML

console.log(`\n🔒 innerHTML Usage`)
console.log(`   Total innerHTML =:          ${totalInnerHTML}`)
console.log(`   Using escapeHtml():         ${safeInnerHTML}`)
console.log(`   Empty/reset (= ""):         ${emptyInnerHTML}`)
console.log(`   Potentially unsafe:         ${unsafeInnerHTML}`)

// Transition: all
const transitionAll = count("transition:\\s*all")
console.log(`\n🎨 CSS`)
console.log(`   transition: all:            ${transitionAll}`, transitionAll === 0 ? "✅" : "⚠️")

// Console.* calls
const consoleCalls = countWithout("console\\.", "client-logger\\|eslint-disable\\|health-check", "lib/")
console.log(`\n🗑️  console.* in lib/:          ${consoleCalls}`, consoleCalls === 0 ? "✅" : "⚠️")

// Buttons without aria-label
const btnNoAria = countWithout('<button', 'aria-label', "components/")
console.log(`\n♿ Buttons without aria-label:  ${btnNoAria}`)

// Inline styles
const inlineStyles = count('style=\\"', "components/")
console.log(`📐 Inline style= in components: ${inlineStyles}`)

console.log(`\n${"─".repeat(50)}`)
console.log(`✅ Health check complete\n`)
