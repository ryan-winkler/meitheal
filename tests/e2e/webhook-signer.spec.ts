import { expect, test } from "@playwright/test"
import {
  signPayload,
  verifySignature,
  isPrivateUrl,
  isPrivateHost,
  parseWebhookConfig,
} from "../../packages/integration-core/src/webhook-config"

test.describe("Webhook Signer", () => {
  test("sign and verify round-trip", () => {
    const secret = "test-secret-key-123"
    const payload = JSON.stringify({ eventType: "task.created", payload: { id: 1 } })
    const signature = signPayload(secret, payload)

    expect(signature).toBeTruthy()
    expect(typeof signature).toBe("string")
    expect(signature.length).toBe(64) // SHA-256 hex = 64 chars
    expect(verifySignature(secret, payload, signature)).toBe(true)
  })

  test("detects tampered payload", () => {
    const secret = "test-secret-key-123"
    const payload = JSON.stringify({ eventType: "task.created" })
    const signature = signPayload(secret, payload)
    const tampered = JSON.stringify({ eventType: "task.deleted" })

    expect(verifySignature(secret, tampered, signature)).toBe(false)
  })

  test("detects wrong secret", () => {
    const payload = JSON.stringify({ eventType: "task.created" })
    const signature = signPayload("secret-a", payload)

    expect(verifySignature("secret-b", payload, signature)).toBe(false)
  })

  test("handles empty payload", () => {
    const secret = "test-secret"
    const signature = signPayload(secret, "")

    expect(signature).toBeTruthy()
    expect(verifySignature(secret, "", signature)).toBe(true)
  })
})

test.describe("Private URL Guard", () => {
  test("rejects localhost", () => {
    expect(isPrivateUrl("http://localhost:3000/webhook")).toBe(true)
    expect(isPrivateHost("localhost")).toBe(true)
  })

  test("rejects 127.x.x.x", () => {
    expect(isPrivateUrl("http://127.0.0.1:8080/hook")).toBe(true)
  })

  test("rejects 10.x.x.x", () => {
    expect(isPrivateUrl("http://10.0.0.1/api")).toBe(true)
  })

  test("rejects 192.168.x.x", () => {
    expect(isPrivateUrl("http://192.168.1.1/callback")).toBe(true)
  })

  test("rejects 172.16-31.x.x", () => {
    expect(isPrivateUrl("http://172.16.0.1/hook")).toBe(true)
    expect(isPrivateUrl("http://172.31.255.255/hook")).toBe(true)
  })

  test("allows public IPs", () => {
    expect(isPrivateUrl("https://example.com/webhook")).toBe(false)
    expect(isPrivateUrl("https://93.184.216.34/hook")).toBe(false)
  })

  test("rejects invalid URLs", () => {
    expect(isPrivateUrl("not-a-url")).toBe(true)
  })
})

test.describe("Webhook Config Parser", () => {
  test("parses valid config", () => {
    const result = parseWebhookConfig({
      webhooks: [
        {
          id: "sub-1",
          url: "https://example.com/hook",
          secret: "my-secret",
          events: ["task.created"],
          enabled: true,
        },
      ],
    })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.subscribers).toHaveLength(1)
      expect(result.subscribers[0]!.id).toBe("sub-1")
    }
  })

  test("rejects private URL subscriber", () => {
    const result = parseWebhookConfig({
      webhooks: [
        {
          id: "bad",
          url: "http://127.0.0.1:3000/hook",
          secret: "s",
          events: ["task.created"],
        },
      ],
    })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.errors.some((e: string) => e.includes("private"))).toBe(true)
    }
  })

  test("rejects missing required fields", () => {
    const result = parseWebhookConfig({ webhooks: [{}] })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.errors.length).toBeGreaterThanOrEqual(3)
    }
  })

  test("rejects non-array webhooks", () => {
    const result = parseWebhookConfig({ webhooks: "not-array" })
    expect(result.ok).toBe(false)
  })
})
