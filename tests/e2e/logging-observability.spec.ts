import { test, expect } from "@playwright/test";
import { createLogger, defaultRedactionPatterns } from "../../packages/domain-observability/src/logger";

test.describe("Logging & Observability", () => {
  let stdoutWrites: string[] = [];
  let originalWrite: any;

  test.beforeAll(() => {
    originalWrite = process.stdout.write;
    process.stdout.write = (chunk: string | Uint8Array) => {
      stdoutWrites.push(chunk.toString());
      return true;
    };
  });

  test.afterAll(() => {
    process.stdout.write = originalWrite;
  });

  test.beforeEach(() => {
    stdoutWrites = [];
  });

  test("generates valid JSON Loki ingestion format", () => {
    const logger = createLogger({
      service: "test-service",
      env: "test",
      minLevel: "info",
      enabledCategories: ["test"],
      redactPatterns: defaultRedactionPatterns,
      auditEnabled: true
    });

    logger.log("info", {
      event: "test.event",
      domain: "test",
      component: "test-comp",
      request_id: "req-1",
      message: "Hello world"
    });

    expect(stdoutWrites.length).toBe(1);
    const parsed = JSON.parse(stdoutWrites[0]!);
    expect(parsed.service).toBe("test-service");
    expect(parsed.env).toBe("test");
    expect(parsed.level).toBe("info");
    expect(parsed.message).toBe("Hello world");
    expect(parsed.ts).toBeDefined();
  });

  test("redacts sensitive PII and tokens", () => {
    const logger = createLogger({
      service: "test-service",
      env: "test",
      minLevel: "info",
      enabledCategories: ["test", "api"],
      redactPatterns: defaultRedactionPatterns,
      auditEnabled: true
    });

    const msg = "User bob@example.com logged in with bearer xyz123 and supervisor_token=abc999!";
    logger.log("info", {
      event: "test.auth",
      domain: "api",
      component: "test-comp",
      request_id: "req-2",
      message: msg
    });

    expect(stdoutWrites.length).toBe(1);
    const parsed = JSON.parse(stdoutWrites[0]!);
    
    expect(parsed.message).toContain("[REDACTED]");
    expect(parsed.message).not.toContain("bob@example.com");
    expect(parsed.message).not.toContain("xyz123");
    expect(parsed.message).not.toContain("abc999");
  });

  test("respects enabledCategory toggles", () => {
    const logger = createLogger({
      service: "custom",
      env: "test",
      minLevel: "info",
      enabledCategories: ["enabled-domain"],
      redactPatterns: [],
      auditEnabled: true
    });

    logger.log("info", { event: "e1", domain: "enabled-domain", component: "c", request_id: "r", message: "m1" });
    logger.log("info", { event: "e2", domain: "disabled-domain", component: "c", request_id: "r", message: "m2" });

    expect(stdoutWrites.length).toBe(1);
    expect(JSON.parse(stdoutWrites[0]!).message).toBe("m1");
  });
});

