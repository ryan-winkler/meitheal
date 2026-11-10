import { test, expect } from "@playwright/test";
import { shouldSkipBrowserSpecs } from "./_helpers";

/**
 * Offline Image Attachment CRUD Tests (Phase 23)
 *
 * Tests the IndexedDB task_attachments store.
 * Uses inline IDB operations within page.evaluate() to avoid
 * cross-workspace TypeScript module resolution issues.
 */

test.describe("Offline Attachment CRUD", () => {
    test.skip(shouldSkipBrowserSpecs(), "Set E2E_BASE_URL to run browser specs");
    test("saveAttachment stores and retrieves by taskId", async ({ page }) => {
        await page.goto("/");
        await page.waitForLoadState("networkidle");

        const result = await page.evaluate(async () => {
            // Open database directly (mirrors offline-store.ts openDatabase)
            const db = await new Promise<IDBDatabase>((resolve, reject) => {
                const req = indexedDB.open("meitheal-offline", 2);
                req.onupgradeneeded = () => {
                    const d = req.result;
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

            const attachment = {
                id: crypto.randomUUID(),
                taskId: "test-task-001",
                filename: "test-image.png",
                mimeType: "image/png",
                base64Data:
                    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYA",
                createdAt: new Date().toISOString(),
            };

            // Save
            await new Promise<void>((resolve, reject) => {
                const tx = db.transaction("task_attachments", "readwrite");
                const store = tx.objectStore("task_attachments");
                const r = store.put(attachment);
                r.onsuccess = () => resolve();
                r.onerror = () => reject(r.error);
            });

            // Get by taskId
            const results = await new Promise<unknown[]>((resolve, reject) => {
                const tx = db.transaction("task_attachments", "readonly");
                const store = tx.objectStore("task_attachments");
                const idx = store.index("taskId");
                const r = idx.getAll(IDBKeyRange.only("test-task-001"));
                r.onsuccess = () => resolve(r.result);
                r.onerror = () => reject(r.error);
            });

            db.close();

            return {
                count: results.length,
                firstFilename: (results[0] as Record<string, string>)?.filename,
                firstMimeType: (results[0] as Record<string, string>)?.mimeType,
                hasBase64: !!(results[0] as Record<string, string>)?.base64Data,
            };
        });

        expect(result.count).toBe(1);
        expect(result.firstFilename).toBe("test-image.png");
        expect(result.firstMimeType).toBe("image/png");
        expect(result.hasBase64).toBe(true);
    });

    test("deleteAttachment removes from store", async ({ page }) => {
        await page.goto("/");
        await page.waitForLoadState("networkidle");

        const result = await page.evaluate(async () => {
            const db = await new Promise<IDBDatabase>((resolve, reject) => {
                const req = indexedDB.open("meitheal-offline", 2);
                req.onupgradeneeded = () => {
                    const d = req.result;
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

            const id = crypto.randomUUID();
            const attachment = {
                id,
                taskId: "test-task-del",
                filename: "delete-me.jpg",
                mimeType: "image/jpeg",
                base64Data: "data:image/jpeg;base64,/9j/4AAQ",
                createdAt: new Date().toISOString(),
            };

            // Save
            await new Promise<void>((resolve, reject) => {
                const tx = db.transaction("task_attachments", "readwrite");
                const r = tx.objectStore("task_attachments").put(attachment);
                r.onsuccess = () => resolve();
                r.onerror = () => reject(r.error);
            });

            // Count before
            const before = await new Promise<number>((resolve, reject) => {
                const tx = db.transaction("task_attachments", "readonly");
                const idx = tx.objectStore("task_attachments").index("taskId");
                const r = idx.getAll(IDBKeyRange.only("test-task-del"));
                r.onsuccess = () => resolve(r.result.length);
                r.onerror = () => reject(r.error);
            });

            // Delete
            await new Promise<void>((resolve, reject) => {
                const tx = db.transaction("task_attachments", "readwrite");
                const r = tx.objectStore("task_attachments").delete(id);
                r.onsuccess = () => resolve();
                r.onerror = () => reject(r.error);
            });

            // Count after
            const after = await new Promise<number>((resolve, reject) => {
                const tx = db.transaction("task_attachments", "readonly");
                const idx = tx.objectStore("task_attachments").index("taskId");
                const r = idx.getAll(IDBKeyRange.only("test-task-del"));
                r.onsuccess = () => resolve(r.result.length);
                r.onerror = () => reject(r.error);
            });

            db.close();
            return { before, after };
        });

        expect(result.before).toBe(1);
        expect(result.after).toBe(0);
    });

    test("getAttachmentsByTaskId returns empty for unknown taskId", async ({
        page,
    }) => {
        await page.goto("/");
        await page.waitForLoadState("networkidle");

        const count = await page.evaluate(async () => {
            const db = await new Promise<IDBDatabase>((resolve, reject) => {
                const req = indexedDB.open("meitheal-offline", 2);
                req.onupgradeneeded = () => {
                    const d = req.result;
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

            const result = await new Promise<unknown[]>((resolve, reject) => {
                const tx = db.transaction("task_attachments", "readonly");
                const idx = tx.objectStore("task_attachments").index("taskId");
                const r = idx.getAll(IDBKeyRange.only("nonexistent-task-999"));
                r.onsuccess = () => resolve(r.result);
                r.onerror = () => reject(r.error);
            });

            db.close();
            return result.length;
        });

        expect(count).toBe(0);
    });

    test("multiple attachments for same taskId are all retrieved", async ({
        page,
    }) => {
        await page.goto("/");
        await page.waitForLoadState("networkidle");

        const count = await page.evaluate(async () => {
            const db = await new Promise<IDBDatabase>((resolve, reject) => {
                const req = indexedDB.open("meitheal-offline", 2);
                req.onupgradeneeded = () => {
                    const d = req.result;
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

            const taskId = "test-task-multi";
            for (let i = 0; i < 3; i++) {
                await new Promise<void>((resolve, reject) => {
                    const tx = db.transaction("task_attachments", "readwrite");
                    const r = tx.objectStore("task_attachments").put({
                        id: crypto.randomUUID(),
                        taskId,
                        filename: `image-${i}.png`,
                        mimeType: "image/png",
                        base64Data: `data:image/png;base64,${i}`,
                        createdAt: new Date().toISOString(),
                    });
                    r.onsuccess = () => resolve();
                    r.onerror = () => reject(r.error);
                });
            }

            const result = await new Promise<unknown[]>((resolve, reject) => {
                const tx = db.transaction("task_attachments", "readonly");
                const idx = tx.objectStore("task_attachments").index("taskId");
                const r = idx.getAll(IDBKeyRange.only(taskId));
                r.onsuccess = () => resolve(r.result);
                r.onerror = () => reject(r.error);
            });

            db.close();
            return result.length;
        });

        expect(count).toBe(3);
    });
});
