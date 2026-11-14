import { getPersistenceClient } from "@domains/tasks/persistence/store";
import { GrocyAdapter, validateGrocyBaseUrl } from "@meitheal/integration-core";
import { createLogger, defaultRedactionPatterns } from "@meitheal/domain-observability";

const logger = createLogger({
  service: "meitheal-web",
  env: process.env.NODE_ENV ?? "development",
  minLevel: "info",
  enabledCategories: ["integrations"],
  redactPatterns: defaultRedactionPatterns,
  auditEnabled: false,
});

export async function createGrocyClient(): Promise<GrocyAdapter | null> {
  try {
    const client = getPersistenceClient();
    const result = await client.execute(
      "SELECT key, value FROM settings WHERE key IN ('grocy_url', 'grocy_api_key')"
    );

    let baseUrl: string | undefined;
    let apiKey: string | undefined;

    for (const row of result.rows) {
      if (row.key === "grocy_url") {
        try {
          baseUrl = JSON.parse(String(row.value));
        } catch {
          baseUrl = String(row.value);
        }
      } else if (row.key === "grocy_api_key") {
        try {
          apiKey = JSON.parse(String(row.value));
        } catch {
          apiKey = String(row.value);
        }
      }
    }

    if (typeof baseUrl !== "string" || typeof apiKey !== "string" || !baseUrl || !apiKey) {
      return null;
    }

    const urlCheck = validateGrocyBaseUrl(baseUrl);
    if (!urlCheck.ok) {
      logger.log("warn", {
        event: "integration.grocy.invalid_url",
        domain: "integrations",
        component: "grocy-client",
        request_id: crypto.randomUUID(),
        message: urlCheck.error,
      });
      return null;
    }

    return new GrocyAdapter({
      baseUrl: urlCheck.normalizedUrl,
      apiKey,
      timeoutMs: 5000,
    });
  } catch (err) {
    logger.log("error", {
      event: "integration.grocy.config_failed",
      domain: "integrations",
      component: "grocy-client",
      request_id: crypto.randomUUID(),
      message: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
