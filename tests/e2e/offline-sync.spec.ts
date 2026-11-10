import { test, expect } from "@playwright/test";
import { shouldSkipBrowserSpecs } from "./_helpers";

test.describe("Offline Sync Queue", () => {
  test.skip(shouldSkipBrowserSpecs(), "Set E2E_BASE_URL to run browser specs");
  test("queues operations in IndexedDB when offline", async ({ page, context }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    // Clear sync_queue
    await page.evaluate(async () => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open("meitheal-offline", 2);
        req.onupgradeneeded = () => {
          const d = req.result;
          if (!d.objectStoreNames.contains("sync_queue")) {
            const s = d.createObjectStore("sync_queue", { keyPath: "id" });
            s.createIndex("createdAt", "createdAt", { unique: false });
          }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });

      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction("sync_queue", "readwrite");
        const r = tx.objectStore("sync_queue").clear();
        r.onsuccess = () => resolve();
        r.onerror = () => reject(r.error);
      });
      db.close();
    });

    // Go offline
    await context.setOffline(true);

    // Simulate pushing an operation
    await page.evaluate(async () => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open("meitheal-offline", 2);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });

      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction("sync_queue", "readwrite");
        const r = tx.objectStore("sync_queue").put({
          id: crypto.randomUUID(),
          operation: "create",
          table: "tasks",
          entityId: "fake-task-a",
          payload: JSON.stringify({ title: "Offline test task" }),
          createdAt: new Date().toISOString(),
          retryCount: 0
        });
        r.onsuccess = () => resolve();
        r.onerror = () => reject(r.error);
      });
      db.close();
    });

    // Verify it's in the queue
    const queuedCount = await page.evaluate(async () => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open("meitheal-offline", 2);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });

      const count = await new Promise<number>((resolve, reject) => {
        const tx = db.transaction("sync_queue", "readonly");
        const r = tx.objectStore("sync_queue").count();
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
      });
      db.close();
      return count;
    });

    expect(queuedCount).toBe(1);

    // Come back online
    await context.setOffline(false);
  });
});

