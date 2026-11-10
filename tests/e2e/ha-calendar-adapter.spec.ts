import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { AddressInfo } from "node:net";
import { expect, test } from "@playwright/test";
import { HomeAssistantCalendarAdapter } from "../../packages/integration-core/src";

function startServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void
): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const server = createServer(handler);
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo;
      resolve({
        baseUrl: `http://127.0.0.1:${address.port}`,
        close: () =>
          new Promise<void>((closeResolve, closeReject) => {
            server.close((error) => {
              if (error) {
                closeReject(error);
                return;
              }
              closeResolve();
            });
          })
      });
    });
  });
}

test("ha calendar adapter returns confirmed result on success", async () => {
  const harness = await startServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.url !== "/api/services/calendar/create_event") {
      res.writeHead(404).end();
      return;
    }

    if (req.headers.authorization !== "Bearer test-token") {
      res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: "unauthorized" }));
      return;
    }

    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify([{ uid: "ha-uid-1" }]));
  });

  try {
    const adapter = new HomeAssistantCalendarAdapter({
      baseUrl: harness.baseUrl,
      token: "test-token",
      timeoutMs: 500
    });

    const result = await adapter.createEvent({
      requestId: "req-1",
      idempotencyKey: "idem-1",
      entityId: "calendar.home",
      summary: "Cook dinner",
      startDateTime: new Date().toISOString(),
      endDateTime: new Date(Date.now() + 30 * 60_000).toISOString()
    });

    expect(result.ok).toBeTruthy();
    if (result.ok) {
      expect(result.confirmationId).toBe("ha-uid-1");
    }
  } finally {
    await harness.close();
  }
});

test("ha calendar adapter maps unauthorized to terminal failure", async () => {
  const harness = await startServer((_req: IncomingMessage, res: ServerResponse) => {
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "unauthorized" }));
  });

  try {
    const adapter = new HomeAssistantCalendarAdapter({
      baseUrl: harness.baseUrl,
      token: "bad-token",
      timeoutMs: 500
    });

    const result = await adapter.createEvent({
      requestId: "req-2",
      idempotencyKey: "idem-2",
      entityId: "calendar.home",
      summary: "Unauthorized",
      startDateTime: new Date().toISOString(),
      endDateTime: new Date(Date.now() + 30 * 60_000).toISOString()
    });

    expect(result.ok).toBeFalsy();
    if (!result.ok) {
      expect(result.errorCode).toBe("unauthorized");
      expect(result.retryable).toBeFalsy();
    }
  } finally {
    await harness.close();
  }
});

test("ha calendar adapter maps timeout to retryable failure", async () => {
  const harness = await startServer((req: IncomingMessage, res: ServerResponse) => {
    const timeout = setTimeout(() => {
      if (res.writableEnded || !res.writable) {
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify([{ uid: "delayed" }]));
    }, 250);
    req.on("close", () => clearTimeout(timeout));
    res.on("close", () => clearTimeout(timeout));
  });

  try {
    const adapter = new HomeAssistantCalendarAdapter({
      baseUrl: harness.baseUrl,
      token: "test-token",
      timeoutMs: 50
    });

    const result = await adapter.createEvent({
      requestId: "req-3",
      idempotencyKey: "idem-3",
      entityId: "calendar.home",
      summary: "Timeout",
      startDateTime: new Date().toISOString(),
      endDateTime: new Date(Date.now() + 30 * 60_000).toISOString()
    });

    expect(result.ok).toBeFalsy();
    if (!result.ok) {
      expect(result.errorCode).toBe("timeout");
      expect(result.retryable).toBeTruthy();
    }
  } finally {
    await harness.close();
  }
});
