import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn, execFile } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";

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

async function waitForHealth(url, version, maxAttempts = 30, delayMs = 500) {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(500) });
      if (response.ok) {
        const health = await response.json();
        if (health.version === version && health.db_integrity === "ok") return;
      } else {
        await response.body?.cancel();
      }
    } catch {
      // Continue polling.
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  throw new Error(`Health check failed for ${url}`);
}

function percentile(sorted, fraction) {
  return sorted[Math.ceil(sorted.length * fraction) - 1];
}

async function getRssKb(pid) {
  const { stdout } = await execFileAsync("ps", ["-o", "rss=", "-p", String(pid)]);
  const rssKb = Number(stdout.trim());
  if (!Number.isInteger(rssKb) || rssKb <= 0) throw new Error("Unable to read the web process RSS");
  return rssKb;
}

async function createTask(baseUrl, title) {
  const start = performance.now();
  const response = await fetch(`${baseUrl}/api/tasks`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: baseUrl },
    body: JSON.stringify({ title }),
    signal: AbortSignal.timeout(5_000),
  });
  if (response.status !== 201) {
    throw new Error(`Task create failed (${response.status}): ${await response.text()}`);
  }
  const task = await response.json();
  if (!task.id || task.title !== title) {
    throw new Error("Task create returned an unexpected task");
  }
  return performance.now() - start;
}

async function measureGetTasks(baseUrl) {
  const start = performance.now();
  const response = await fetch(`${baseUrl}/tasks`, {
    signal: AbortSignal.timeout(10_000),
  });
  if (response.status !== 200) {
    throw new Error(`GET /tasks failed (${response.status}): ${await response.text()}`);
  }
  await response.text();
  return performance.now() - start;
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
  const serviceWorker = await fs.stat(path.join(clientDir, "sw.js"));
  const clientBytes = await sizeOfDirectoryBytes(path.join(clientDir, "_astro")) + serviceWorker.size;
  const distClientBytes = await sizeOfDirectoryBytes(clientDir);

  const scratchDir = await fs.mkdtemp(path.join(os.tmpdir(), "meitheal-perf-"));
  const version = path.basename(scratchDir);
  const dbPath = path.join(scratchDir, "tasks.db");
  const dbUrl = `file:${dbPath}`;
  // Ask the kernel for a free port and read it from this child only.
  const server = spawn(process.execPath, ["--max-old-space-size=128", "--input-type=module", "--eval", `
    const { startServer } = await import("./dist/server/entry.mjs")
    const { server, done } = startServer()
    server.server.once("listening", () => process.send(server.server.address().port))
    await done
  `], {
    cwd: appRoot,
    env: {
      PATH: process.env.PATH,
      NODE_ENV: "production",
      HOST: "127.0.0.1",
      PORT: "0",
      ASTRO_NODE_AUTOSTART: "disabled",
      MEITHEAL_VERSION: version,
      MEITHEAL_DB_URL: dbUrl
    },
    stdio: ["ignore", "ignore", "inherit", "ipc"]
  })
  const closed = once(server, "close")

  try {
    const [port] = await Promise.race([
      once(server, "message", { signal: AbortSignal.timeout(15_000) }),
      closed.then(([code, signal]) => {
        throw new Error(`Benchmark server exited before listening (${signal ?? code})`)
      }),
    ])
    if (!Number.isInteger(port) || port < 1024 || port > 65535) {
      throw new Error("Benchmark server did not report a valid port")
    }
    const baseUrl = `http://127.0.0.1:${port}`
    await waitForHealth(`${baseUrl}/api/health`, version);
    const warmups = 5;
    const requests = 100;
    for (let index = 0; index < warmups; index += 1) {
      await createTask(baseUrl, `perf-warmup-${index}`);
    }
    const rssKb = await getRssKb(server.pid);

    const latenciesMs = [];
    for (let index = 0; index < requests; index += 1) {
      latenciesMs.push(await createTask(baseUrl, `perf-check-${index}`));
    }

    let kanbanWarm2000;
    let hasTasks = false;
    let totalTasks = 0;
    let db;
    try {
      db = new DatabaseSync(dbPath, { timeout: 5000 });
      const hasTasksTable = db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'tasks'").get();
      if (hasTasksTable) {
        const task = db.prepare(`INSERT INTO tasks
          (id, title, description, status, request_id, idempotency_key, created_at, updated_at)
          VALUES (?, ?, ?, 'pending', ?, ?, ?, ?)`);
        const stamp = Date.now();
        db.exec("BEGIN IMMEDIATE");
        try {
          for (let index = 1; index <= 2000; index++) {
            const id = `perf-kanban-${index}`;
            task.run(id, `Perf task ${index}`, "Performance test card", id, id, stamp + index, stamp + index);
          }
          db.exec("COMMIT");
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
        totalTasks = Number(db.prepare("SELECT COUNT(*) AS count FROM tasks").get().count);
        hasTasks = true;
      }
    } catch (error) {
      // Stub servers in the lifecycle tests have no SQLite tasks table, so the
      // measurement is skipped. A real seeding failure is reported, not measured.
      if (db) kanbanWarm2000 = { skipped: `seed failed: ${error instanceof Error ? error.message : String(error)}` };
    } finally {
      db?.close();
    }

    if (hasTasks) {
      const kanbanWarmups = 5;
      const kanbanRequests = 25;
      for (let index = 0; index < kanbanWarmups; index += 1) {
        await measureGetTasks(baseUrl);
      }
      const kanbanSamplesMs = [];
      for (let index = 0; index < kanbanRequests; index += 1) {
        kanbanSamplesMs.push(await measureGetTasks(baseUrl));
      }
      const sortedKanbanSamples = [...kanbanSamplesMs].sort((a, b) => a - b);
      const kanbanP50Ms = percentile(sortedKanbanSamples, 0.50);
      const kanbanP95Ms = percentile(sortedKanbanSamples, 0.95);
      const kanbanMaxMs = sortedKanbanSamples.at(-1);

      kanbanWarm2000 = {
        seededTasks: 2000,
        totalTasks,
        warmups: kanbanWarmups,
        requests: kanbanRequests,
        samplesMs: kanbanSamplesMs.map((value) => Number(value.toFixed(1))),
        p50Ms: Number(kanbanP50Ms.toFixed(1)),
        p95Ms: Number(kanbanP95Ms.toFixed(1)),
        maxMs: Number(kanbanMaxMs.toFixed(1)),
      };
    }

    latenciesMs.sort((a, b) => a - b);
    const p95Ms = percentile(latenciesMs, 0.95);
    const failures = [];
    if (clientBytes > budgets.clientBytesMax) {
      failures.push(`Generated client assets too large: ${clientBytes} bytes > ${budgets.clientBytesMax}`);
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
          measurement: {
            operation: "POST /api/tasks",
            fixture: "fresh local SQLite database",
            requestTiming: "send through validated response body",
            percentileMethod: "nearest-rank",
            p95Rank: Math.ceil(requests * 0.95),
            rssTiming: "web process after warmup writes"
          },
          observed: {
            clientBytes,
            distClientBytes,
            rssKb,
            warmups,
            requests,
            p50Ms: Number(percentile(latenciesMs, 0.50).toFixed(1)),
            p95Ms: Number(p95Ms.toFixed(1)),
            p99Ms: Number(percentile(latenciesMs, 0.99).toFixed(1)),
            maxMs: Number(latenciesMs.at(-1).toFixed(1)),
            overBudgetRequests: latenciesMs.filter(value => value > budgets.p95MsMax).length,
          },
          ...(kanbanWarm2000 ? { kanbanWarm2000 } : {})
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
    server.kill("SIGTERM");
    const killTimeout = setTimeout(() => server.kill("SIGKILL"), 2_000);
    try {
      await closed
    } finally {
      clearTimeout(killTimeout)
      await fs.rm(scratchDir, { recursive: true, force: true })
    }
  }
}

await main();
