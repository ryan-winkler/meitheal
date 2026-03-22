import type { APIRoute } from "astro";
import { readFileSync, existsSync } from "fs";
import path from "path";
import { exportFilename } from "../../../lib/export-filename";
import { logApiError } from "../../../lib/api-logger";
import { apiProblem } from "../../../lib/api-response";

export const GET: APIRoute = async ({ locals }) => {
    if (!locals.hassIsAdmin && !locals.agentToken?.scopes.includes("settings:write")) {
        return apiProblem({ status: 403, title: "Admin Required", detail: "Database export requires admin access or settings:write scope" })
    }
    try {
        // Resolve DB path - matching the store.ts resolveDbUrl output for the file approach
        const dbUrl = process.env.MEITHEAL_DB_URL ?? "file:./.data/meitheal.db";
        if (!dbUrl.startsWith("file:")) {
            return new Response(JSON.stringify({ error: "Database is not file-based (Remote connection). Extraction unavailable." }), { status: 400, headers: { "content-type": "application/json" } });
        }

        const dbPath = dbUrl.slice("file:".length);
        const absolutePath = path.isAbsolute(dbPath) ? dbPath : path.join(process.cwd(), dbPath);

        if (!existsSync(absolutePath)) {
            return new Response(JSON.stringify({ error: "Database file not found on server." }), { status: 404, headers: { "content-type": "application/json" } });
        }

        // Read the binary sqlite file to a buffer
        const buffer = readFileSync(absolutePath);

        return new Response(buffer, {
            status: 200,
            headers: {
                "Content-Type": "application/x-sqlite3",
                "Content-Disposition": `attachment; filename="${exportFilename("Database", "db")}"`,
                "Content-Length": buffer.length.toString()
            }
        });

    } catch (error) {
        logApiError("export-database", "Failed to export database", error);
        return new Response(JSON.stringify({ error: "Export failed" }), { status: 500, headers: { "content-type": "application/json" } });
    }
};
