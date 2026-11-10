import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn, execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { performance } from "node:perf_hooks";

const execFileAsync = promisify(execFile);

const defaultBudgets = {
  clientBytesMax: 100 * 1024,
  rssKbMax: 220 * 1024,
  p95MsMax: 250
};

function parsePositiveInteger(value) {
  if (!value) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function parsePositiveNumber(value) {
  if (!value) {
    return undefined;
  }
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

async function loadBudgets(scriptDir) {
  const configuredPath = process.env.MEITHEAL_PERF_BUDGET_FILE;
  let budgets = { ...defaultBudgets };

  const shouldLoadBaseline = true; // Always try baseline first, fall back to defaults if missing
  if (shouldLoadBaseline) {
    const baselinePath = configuredPath
      ? path.resolve(process.cwd(), configuredPath)
      : path.join(scriptDir, "perf-budget-baseline.json");

    try {
      const raw = await fs.readFile(baselinePath, "utf8");
      const parsed = JSON.parse(raw);
      const fromFile = parsed.budgets;
      if (fromFile) {
        budgets = {
          clientBytesMax: parsePositiveInteger(String(fromFile.clientBytesMax)) ?? budgets.clientBytesMax,
          rssKbMax: parsePositiveInteger(String(fromFile.rssKbMax)) ?? budgets.rssKbMax,
          p95MsMax: parsePositiveNumber(String(fromFile.p95MsMax)) ?? budgets.p95MsMax
        };
      }
    } catch {
      // Missing baseline file should not break CI; defaults remain fail-closed.
    }
  }

  budgets = {
    clientBytesMax: parsePositiveInteger(process.env.MEITHEAL_PERF_BUDGET_CLIENT_BYTES_MAX) ?? budgets.clientBytesMax,
    rssKbMax: parsePositiveInteger(process.env.MEITHEAL_PERF_BUDGET_RSS_KB_MAX) ?? budgets.rssKbMax,
    p95MsMax: parsePositiveNumber(process.env.MEITHEAL_PERF_BUDGET_P95_MS_MAX) ?? budgets.p95MsMax
  };

  return budgets;
}

async function sizeOfDirectoryBytes(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  let total = 0;
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      total += await sizeOfDirectoryBytes(full);
      continue;
    }
    const stat = await fs.stat(full);
    total += stat.size;
  }
  return total;
}

async function waitForHealth(url, maxAttempts = 30, delayMs = 500) {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
    } catch {
      // Continue polling.
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  throw new Error(`Health check failed for ${url}`);
}

function p95(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.max(0, Math.ceil(sorted.length * 0.95) - 1);
  return sorted[index] ?? 0;
}

async function getRssKb(pid) {
  const { stdout } = await execFileAsync("ps", ["-o", "rss=", "-p", String(pid)]);
  return Number.parseInt(stdout.trim(), 10);
}

async function stopOwnedServer(server) {
  if (server.exitCode !== null || server.signalCode !== null) return;
  await new Promise((resolve) => {
    // Application SIGTERM handlers may leave the HTTP listener alive. Always
    // reap this harness-owned process, including after a failed measurement.
    const killTimer = setTimeout(() => server.kill("SIGKILL"), 2_000);
    server.once("close", () => {
      clearTimeout(killTimer);
      resolve();
    });
    server.kill("SIGTERM");
  });
}

async function main() {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const budgets = await loadBudgets(scriptDir);
  const appRoot = path.resolve(scriptDir, "..");
  const entryFile = path.join(appRoot, "dist/server/entry.mjs");
  try {
    await fs.access(entryFile);
  } catch {
    console.error("Error: dist/server/entry.mjs not found. Run 'pnpm --filter web build' first.");
    process.exit(1);
  }

  const clientDir = path.join(appRoot, "dist/client");
  const clientBytes = await sizeOfDirectoryBytes(clientDir);

  const port = 4600 + Math.floor(Math.random() * 300);
  const dbPath = path.join(os.tmpdir(), `meitheal-perf-${Date.now()}-${Math.random()}.db`);
  const dbUrl = `file:${dbPath}`;
  const baseUrl = `http://127.0.0.1:${port}`;

  const server = spawn(process.execPath, ["--max-old-space-size=128", "dist/server/entry.mjs"], {
    cwd: appRoot,
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      MEITHEAL_DB_URL: dbUrl
    },
    // Server logs are not benchmark output; unused pipes can retain handles or
    // backpressure a noisy server. Only the harness emits the measured result.
    stdio: "ignore"
  });

  try {
    await waitForHealth(`${baseUrl}/api/health`);
    const rssKb = await getRssKb(server.pid);

    const latenciesMs = [];
    for (let index = 0; index < 20; index += 1) {
      const start = performance.now();
      const response = await fetch(`${baseUrl}/api/tasks/create`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "origin": baseUrl,
        },
        body: JSON.stringify({ title: `perf-check-${index}` })
      });
      const end = performance.now();
      if (!response.ok) {
        const body = await response.text();
        throw new Error(`Task create failed (${response.status}): ${body}`);
      }
      latenciesMs.push(end - start);
    }

    const p95Ms = p95(latenciesMs);
    const failures = [];
    if (clientBytes > budgets.clientBytesMax) {
      failures.push(`Client bundle too large: ${clientBytes} bytes > ${budgets.clientBytesMax}`);
    }
    if (rssKb > budgets.rssKbMax) {
      failures.push(`RSS too high: ${rssKb} KB > ${budgets.rssKbMax} KB`);
    }
    if (p95Ms > budgets.p95MsMax) {
      failures.push(`Task create p95 too high: ${p95Ms.toFixed(1)} ms > ${budgets.p95MsMax} ms`);
    }

    console.log(
      JSON.stringify(
        {
          budgets,
          observed: {
            clientBytes,
            rssKb,
            p95Ms: Number(p95Ms.toFixed(1))
          }
        },
        null,
        2
      )
    );

    if (failures.length > 0) {
      for (const failure of failures) {
        console.error(failure);
      }
      process.exitCode = 1;
    }
  } finally {
    await stopOwnedServer(server);
  }
}

await main();
