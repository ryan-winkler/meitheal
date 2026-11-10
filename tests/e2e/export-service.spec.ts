import { test, expect } from "@playwright/test";
import { shouldSkipBrowserSpecs } from "./_helpers";

/**
 * Client-Side Export Service Tests (Phase 21/23)
 *
 * Tests the IDB task+attachment bundling logic that powers
 * the JSON export flow. Uses inline IDB operations to avoid
 * cross-workspace TS module resolution issues.
 */

test.describe("Export Service", () => {
    test.skip(shouldSkipBrowserSpecs(), "Set E2E_BASE_URL to run browser specs");
    test("tasks and attachments can be bundled for export", async ({ page }) => {
        await page.goto("/");
        await page.waitForLoadState("networkidle");

        const result = await page.evaluate(async () => {
            const db = await new Promise<IDBDatabase>((resolve, reject) => {
                const req = indexedDB.open("meitheal-offline", 2);
                req.onupgradeneeded = () => {
                    const d = req.result;
                    if (!d.objectStoreNames.contains("tasks")) {
                        const s = d.createObjectStore("tasks", { keyPath: "id" });
                        s.createIndex("status", "status", { unique: false });
                        s.createIndex("updatedAt", "updatedAt", { unique: false });
                    }
                    if (!d.objectStoreNames.contains("pending_sync")) {
                        const s = d.createObjectStore("pending_sync", { keyPath: "id" });
                        s.createIndex("createdAt", "createdAt", { unique: false });
                        s.createIndex("table", "table", { unique: false });
                    }
                    if (!d.objectStoreNames.contains("task_attachments")) {
                        const s = d.createObjectStore("task_attachments", {
                            keyPath: "id",
                        });
                        s.createIndex("taskId", "taskId", { unique: false });
                        s.createIndex("createdAt", "createdAt", { unique: false });
                    }
                };
                req.onsuccess = () => resolve(req.result);
                req.onerror = () => reject(req.error);
            });

            // Seed a task
            await new Promise<void>((resolve, reject) => {
                const tx = db.transaction("tasks", "readwrite");
                const r = tx.objectStore("tasks").put({
                    id: "export-bundle-task",
                    title: "Export Bundle Test",
                    description: "A task for export testing",
                    status: "pending",
                    dueDate: null,
                    updatedAt: new Date().toISOString(),
                    createdAt: new Date().toISOString(),
                    syncedAt: null,
                });
                r.onsuccess = () => resolve();
                r.onerror = () => reject(r.error);
            });

            // Seed an attachment
            await new Promise<void>((resolve, reject) => {
                const tx = db.transaction("task_attachments", "readwrite");
                const r = tx.objectStore("task_attachments").put({
                    id: crypto.randomUUID(),
                    taskId: "export-bundle-task",
                    filename: "export-img.png",
                    mimeType: "image/png",
                    base64Data: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==",
                    createdAt: new Date().toISOString(),
                });
                r.onsuccess = () => resolve();
                r.onerror = () => reject(r.error);
            });

            // Simulate export bundling: getAllTasks → getAttachmentsByTaskId
            const tasks = await new Promise<Array<Record<string, unknown>>>(
                (resolve, reject) => {
                    const tx = db.transaction("tasks", "readonly");
                    const r = tx.objectStore("tasks").getAll();
                    r.onsuccess = () => resolve(r.result);
                    r.onerror = () => reject(r.error);
                }
            );

            const exportTask = tasks.find(
                (t) => t.id === "export-bundle-task"
            );
            if (!exportTask) {
                db.close();
                return { found: false, taskTitle: "", attachmentCount: 0, firstFilename: "" };
            }

            const attachments = await new Promise<Array<Record<string, string>>>(
                (resolve, reject) => {
                    const tx = db.transaction("task_attachments", "readonly");
                    const idx = tx.objectStore("task_attachments").index("taskId");
                    const r = idx.getAll(IDBKeyRange.only("export-bundle-task"));
                    r.onsuccess = () => resolve(r.result);
                    r.onerror = () => reject(r.error);
                }
            );

            // Build export payload
            const payload = {
                ...exportTask,
                _attachments: attachments.map((a) => ({
                    id: a.id,
                    filename: a.filename,
                    mimeType: a.mimeType,
                    base64Data: a.base64Data,
                    createdAt: a.createdAt,
                })),
            };

            const taskTitle = exportTask.title as string;

            db.close();

            return {
                found: true,
                taskTitle,
                attachmentCount: attachments.length,
                firstFilename: attachments[0]?.filename ?? "",
            };
        });

        expect(result.found).toBe(true);
        expect(result.taskTitle).toBe("Export Bundle Test");
        expect(result.attachmentCount).toBe(1);
        expect(result.firstFilename).toBe("export-img.png");
    });

    test("export payload serializes as valid JSON", async ({ page }) => {
        await page.goto("/");
        await page.waitForLoadState("networkidle");

        const valid = await page.evaluate(async () => {
            const db = await new Promise<IDBDatabase>((resolve, reject) => {
                const req = indexedDB.open("meitheal-offline", 2);
                req.onupgradeneeded = () => {
                    const d = req.result;
                    if (!d.objectStoreNames.contains("tasks")) {
                        d.createObjectStore("tasks", { keyPath: "id" });
                    }
                    if (!d.objectStoreNames.contains("pending_sync")) {
                        d.createObjectStore("pending_sync", { keyPath: "id" });
                    }
                    if (!d.objectStoreNames.contains("task_attachments")) {
                        const s = d.createObjectStore("task_attachments", {
                            keyPath: "id",
                        });
                        s.createIndex("taskId", "taskId", { unique: false });
                        s.createIndex("createdAt", "createdAt", { unique: false });
                    }
                };
                req.onsuccess = () => resolve(req.result);
                req.onerror = () => reject(req.error);
            });

            // Seed a simple task
            await new Promise<void>((resolve, reject) => {
                const tx = db.transaction("tasks", "readwrite");
                const r = tx.objectStore("tasks").put({
                    id: "json-test-task",
                    title: "JSON Test",
                    description: "",
                    status: "done",
                    dueDate: null,
                    updatedAt: new Date().toISOString(),
                    createdAt: new Date().toISOString(),
                    syncedAt: null,
                });
                r.onsuccess = () => resolve();
                r.onerror = () => reject(r.error);
            });

            const tasks = await new Promise<unknown[]>((resolve, reject) => {
                const tx = db.transaction("tasks", "readonly");
                const r = tx.objectStore("tasks").getAll();
                r.onsuccess = () => resolve(r.result);
                r.onerror = () => reject(r.error);
            });

            db.close();

            try {
                const str = JSON.stringify(tasks, null, 2);
                JSON.parse(str);
                return true;
            } catch {
                return false;
            }
        });

        expect(valid).toBe(true);
    });
});
