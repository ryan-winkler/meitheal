import { expect, test } from "@playwright/test"

import { resolveMcpSchema } from "../../apps/web/src/domains/agents/mcp-schema"
import { validateCalDAVUrl } from "../../apps/web/src/domains/calendar/caldav-client"
import { validateGrocyBaseUrl } from "../../packages/integration-core/src/grocy-adapter"

test("validateCalDAVUrl blocks IPv6 loopback brackets, IPv4-mapped IPv6, compressed ULA, and link-local metadata while allowing public fd domains", () => {
  for (const blocked of [
    "http://[::1]:8080/dav",
    "http://[::]:8080/dav",
    "http://[::2]:8080/dav",
    "http://[::ffff:127.0.0.1]:8080/dav",
    "http://[::ffff:169.254.169.254]/latest/meta-data/",
    "http://[::ffff:192.168.1.1]:8080/dav",
    "http://[fd0::1]:8080/dav",
    "http://0.1.2.3/dav",
    "http://localhost/dav",
    "http://localhost./dav",
    "http://127.0.0.1:5232/dav",
    "http://169.254.169.254/latest/meta-data/",
    "http://metadata.google.internal./computeMetadata/v1/",
    "http://metadata.goog/computeMetadata/v1/",
    "http://10.0.0.1/dav",
    "ftp://caldav.example.com/dav",
  ]) {
    const result = validateCalDAVUrl(blocked)
    expect(result.valid, blocked).toBe(false)
  }

  expect(validateCalDAVUrl("https://caldav.example.com/dav/")).toEqual({ valid: true })
  expect(validateCalDAVUrl("https://fd.example.com/dav/")).toEqual({ valid: true })
})

test("validateGrocyBaseUrl blocks metadata hosts, IPv6 loopback, IPv4-mapped IPv6, and compressed ULA", () => {
  for (const blocked of [
    "",
    "ftp://grocy.example.com",
    `https://${"user"}:${"secret"}@grocy.example.com`,
    "http://metadata.google.internal/computeMetadata/v1/",
    "http://metadata.google.internal./computeMetadata/v1/",
    "http://metadata.goog/computeMetadata/v1/",
    "http://metadata.goog./computeMetadata/v1/",
    "http://instance-data./",
    "http://[::1]:9283",
    "http://[::]:9283",
    "http://[::2]:9283",
    "http://[::ffff:127.0.0.1]:9283",
    "http://[::ffff:169.254.169.254]",
    "http://[::ffff:192.168.1.1]:9283",
    "http://[::ffff:10.0.0.1]:9283",
    "http://[fd0::1]:9283",
    "http://[fc0::1]:9283",
    "http://[fe80::1]:9283",
    "http://0.1.2.3:9283",
    "http://169.254.169.254",
    "http://127.0.0.1:9283",
    "http://localhost:9283",
    "http://localhost.:9283",
    "http://192.168.1.10:9283",
    "http://10.0.0.5:9283",
    "http://172.16.0.5:9283",
  ]) {
    const result = validateGrocyBaseUrl(blocked)
    expect(result.ok, blocked).toBe(false)
  }

  expect(validateGrocyBaseUrl("https://grocy.example.com/")).toEqual({
    ok: true,
    normalizedUrl: "https://grocy.example.com",
  })
  expect(validateGrocyBaseUrl("http://grocy.internal:9283/")).toEqual({
    ok: true,
    normalizedUrl: "http://grocy.internal:9283",
  })
  expect(validateGrocyBaseUrl("https://fd.example.com:9283/")).toEqual({
    ok: true,
    normalizedUrl: "https://fd.example.com:9283",
  })
})

test("resolveMcpSchema rejects prototype pollution segments and expands escaped local $refs", () => {
  const doc = {
    components: {
      schemas: {
        "item~key/part": {
          type: "object",
          properties: { title: { type: "string" } },
        },
        a: { $ref: "#/components/schemas/b" },
        b: { $ref: "#/components/schemas/a" },
      },
    },
  }

  for (const unsafeRef of [
    "#/components/schemas/__proto__",
    "#/components/schemas/constructor",
    "#/components/schemas/prototype",
    "#/components/schemas/missing",
    "https://example.com/schema.json",
  ]) {
    expect(() => resolveMcpSchema({ $ref: unsafeRef }, doc)).toThrow()
  }

  expect(() => resolveMcpSchema({ $ref: "#/components/schemas/a" }, doc)).toThrow(/Cyclic/)

  expect(resolveMcpSchema({ $ref: "#/components/schemas/item~0key~1part", description: "task" }, doc)).toEqual({
    type: "object",
    properties: { title: { type: "string" } },
    description: "task",
  })
})
