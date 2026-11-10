/**
 * Export Service
 *
 * Provides client-side utilities for exporting task data to JSON and CSV formats.
 * Bounded context: offline / tasks
 */

import { getAllTasks } from "./offline-store";
import { getAttachmentsByTaskId } from "./offline-store";

export async function exportLocalDataAsJson(): Promise<void> {
    const tasks = await getAllTasks();
    const payload = [];

    for (const task of tasks) {
        const attachments = await getAttachmentsByTaskId(task.id);
        payload.push({
            ...task,
            _attachments: attachments.map(a => ({
                id: a.id,
                filename: a.filename,
                mimeType: a.mimeType,
                base64Data: a.base64Data,
                createdAt: a.createdAt
            }))
        });
    }

    const dataStr = JSON.stringify(payload, null, 2);
    const blob = new Blob([dataStr], { type: "application/json" });
    triggerDownload(blob, `meitheal-local-export-${new Date().toISOString().split("T")[0]}.json`);
}

/**
 * Export all local tasks as a CSV file.
 * Includes BOM for Excel UTF-8 compatibility.
 */
export async function exportLocalDataAsCsv(): Promise<void> {
    const tasks = await getAllTasks();

    const headers = ["id", "title", "description", "status", "priority", "due_date", "labels", "created_at", "updated_at"];

    const escapeCsv = (val: unknown): string => {
        if (val === null || val === undefined) return '""';
        const str = String(val);
        if (str.includes(',') || str.includes('\n') || str.includes('"')) {
            return `"${str.replace(/"/g, '""')}"`;
        }
        return `"${str}"`;
    };

    const rows = tasks.map(t => headers.map(h => escapeCsv((t as unknown as Record<string, unknown>)[h])).join(","));
    // BOM for Excel UTF-8 compatibility
    const csvContent = "\uFEFF" + [headers.join(","), ...rows].join("\n");

    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8" });
    triggerDownload(blob, `meitheal-local-export-${new Date().toISOString().split("T")[0]}.csv`);
}

function triggerDownload(blob: Blob, filename: string): void {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}
