import { expect, test } from "@playwright/test"
import { parseAiHandoffUrl } from "../../apps/web/src/lib/ai-handoff-url"

test("permits credential-free HTTP and HTTPS provider links", () => {
  expect(parseAiHandoffUrl(" https://assistant.example/chat ")?.href).toBe("https://assistant.example/chat")
  expect(parseAiHandoffUrl("http://localhost:11434")?.href).toBe("http://localhost:11434/")
})

test("rejects malformed links, embedded credentials and executable schemes", () => {
  for (const address of [null, "", "/relative", "//example.com", "javascript:void(0)",
    "data:text/html,example", "file:///etc/passwd", "https://name@assistant.example",
    "https://name:password@assistant.example"]) {
    expect(parseAiHandoffUrl(address)).toBeNull()
  }
})
