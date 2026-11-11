import { expect, test } from "@playwright/test";
import { createLogger, defaultRedactionPatterns } from "../../packages/domain-observability/src";

test("logger redacts tokens and email values", () => {
  const chunks: string[] = [];
  const originalWrite = process.stdout.write.bind(process.stdout);

  process.stdout.write = ((chunk: string | Uint8Array) => {
    chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  }) as typeof process.stdout.write;

  try {
    const logger = createLogger({
      service: "meitheal-tests",
      env: "test",
      minLevel: "info",
      enabledCategories: ["auth"],
      redactPatterns: defaultRedactionPatterns,
      auditEnabled: true
    });

    logger.log("info", {
      event: "auth.login",
      domain: "auth",
      component: "unit-test",
      request_id: "req-logger",
      message:
        "authorization: Bearer abc123 <user@example.com>, (Case+note%2@example.test) 100% complete hassio_token=secret ha_token=HA123 supervisor_token=SUP456",
      metadata: { emailPair: "first@example.test123@example.test" }
    });
  } finally {
    process.stdout.write = originalWrite;
  }

  const output = chunks.join("");
  expect(output).toContain("[REDACTED]");
  expect(output).not.toContain("abc123");
  expect(output).not.toContain("user@example.com");
  expect(output).not.toContain("Case+note%2@example.test");
  expect(output).toContain("<[REDACTED]>, ([REDACTED]) 100% complete");
  expect(JSON.parse(output).metadata.emailPair).toMatch(/^(?:\[REDACTED\])+$/);
  expect(output).not.toContain("hassio_token=secret");
  expect(output).not.toContain("ha_token=HA123");
  expect(output).not.toContain("supervisor_token=SUP456");
  expect(output).toContain("hassio_token=[REDACTED]");
  expect(output).toContain("ha_token=[REDACTED]");
  expect(output).toContain("supervisor_token=[REDACTED]");
});
