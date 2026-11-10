import type { CalendarCreateEventInput, CalendarIntegrationAdapter, CalendarResult } from "./index";

export interface HomeAssistantCalendarAdapterConfig {
  baseUrl: string;
  token: string;
  timeoutMs?: number;
}

export interface ResolvedHomeAssistantAuth {
  baseUrl: string;
  token: string;
  source: "supervisor" | "env";
}

function readEnv(name: string): string | undefined {
  const maybeProcess = globalThis as { process?: { env?: Record<string, string | undefined> } };
  return maybeProcess.process?.env?.[name];
}

export function resolveHomeAssistantAuthFromEnv(): ResolvedHomeAssistantAuth {
  const supervisorToken = readEnv("SUPERVISOR_TOKEN");
  if (supervisorToken) {
    return {
      baseUrl: "http://supervisor/core",
      token: supervisorToken,
      source: "supervisor"
    };
  }

  const baseUrl = readEnv("HA_BASE_URL");
  const token = readEnv("HA_TOKEN");
  if (baseUrl && token) {
    // Defense-in-depth: validate HA_BASE_URL points to a trusted target
    // before forwarding the bearer token. Prevents secret exfiltration
    // if a malicious URL is injected into the environment.
    try {
      const parsed = new URL(baseUrl);
      const allowedProtocols = ["http:", "https:"];
      const trustedHosts = ["supervisor", "localhost", "127.0.0.1", "::1", "homeassistant", "homeassistant.local"];
      const isTrustedHost =
        trustedHosts.includes(parsed.hostname.toLowerCase()) ||
        parsed.hostname.startsWith("192.168.") ||
        parsed.hostname.startsWith("10.") ||
        /^172\.(1[6-9]|2\d|3[0-1])\./.test(parsed.hostname) ||
        parsed.hostname.endsWith(".local");

      if (!allowedProtocols.includes(parsed.protocol) || !isTrustedHost) {
        throw new Error(
          `HA_BASE_URL "${parsed.hostname}" is not a trusted target. ` +
          "Only supervisor, localhost, and private network hosts are allowed."
        );
      }
    } catch (error) {
      if (error instanceof TypeError) {
        throw new Error(`HA_BASE_URL is not a valid URL: ${baseUrl}`);
      }
      throw error;
    }
    return {
      baseUrl,
      token,
      source: "env"
    };
  }

  throw new Error("Missing Home Assistant credentials. Set SUPERVISOR_TOKEN or HA_BASE_URL + HA_TOKEN.");
}

function classifyError(status: number): Pick<Extract<CalendarResult, { ok: false }>, "errorCode" | "retryable" | "retryAfterSeconds"> {
  if (status === 401 || status === 403) {
    return { errorCode: "unauthorized", retryable: false };
  }
  if (status === 400 || status === 422) {
    return { errorCode: "invalid_request", retryable: false };
  }
  if (status === 429) {
    return { errorCode: "service_unavailable", retryable: true, retryAfterSeconds: 30 };
  }
  if (status >= 500) {
    return { errorCode: "service_unavailable", retryable: true, retryAfterSeconds: 60 };
  }
  return { errorCode: "unknown", retryable: true, retryAfterSeconds: 60 };
}

function tryExtractProviderEventId(payload: unknown): string | undefined {
  if (Array.isArray(payload) && payload.length > 0) {
    const first = payload[0] as Record<string, unknown>;
    const uid = typeof first?.uid === "string" ? first.uid : undefined;
    const eventId = typeof first?.event_id === "string" ? first.event_id : undefined;
    return uid ?? eventId;
  }

  if (payload && typeof payload === "object") {
    const obj = payload as Record<string, unknown>;
    if (typeof obj.uid === "string") {
      return obj.uid;
    }
    if (typeof obj.event_id === "string") {
      return obj.event_id;
    }
  }

  return undefined;
}

export class HomeAssistantCalendarAdapter implements CalendarIntegrationAdapter {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly timeoutMs: number;

  constructor(config: HomeAssistantCalendarAdapterConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, "");
    this.token = config.token;
    this.timeoutMs = config.timeoutMs ?? 8_000;
  }

  async createEvent(input: CalendarCreateEventInput): Promise<CalendarResult> {
    const endpoint = `${this.baseUrl}/api/services/calendar/create_event`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(endpoint, {
        method: "POST",
        signal: controller.signal,
        headers: {
          authorization: `Bearer ${this.token}`,
          "content-type": "application/json",
          "x-meitheal-idempotency-key": input.idempotencyKey,
          "x-meitheal-request-id": input.requestId
        },
        body: JSON.stringify({
          entity_id: input.entityId,
          summary: input.summary,
          description: input.description,
          start_date_time: input.startDateTime,
          end_date_time: input.endDateTime
        })
      });

      const rawText = await response.text();
      let raw: unknown;
      if (rawText) {
        try {
          raw = JSON.parse(rawText);
        } catch {
          raw = rawText;
        }
      }

      if (!response.ok) {
        const classification = classifyError(response.status);
        return {
          ok: false,
          ...classification,
          raw
        };
      }

      const providerEventId = tryExtractProviderEventId(raw);
      return {
        ok: true,
        confirmationId: providerEventId ?? crypto.randomUUID(),
        ...(providerEventId ? { providerEventId } : {}),
        raw
      };
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        return {
          ok: false,
          errorCode: "timeout",
          retryable: true,
          retryAfterSeconds: 30
        };
      }

      return {
        ok: false,
        errorCode: "unknown",
        retryable: true,
        retryAfterSeconds: 60,
        raw: {
          message: error instanceof Error ? error.message : "Unknown calendar adapter error"
        }
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}
