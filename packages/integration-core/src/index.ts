export interface DomainEvent<TPayload = Record<string, unknown>> {
  eventId: string;
  eventType: string;
  occurredAt: string;
  requestId: string;
  payload: TPayload;
  /** CloudEvents source URI — defaults to '/meitheal' */
  source?: string;
  /** W3C trace-id for distributed trace propagation */
  traceId?: string;
}

export interface IntegrationPlugin {
  key: string;
  handle(event: DomainEvent): Promise<void>;
}

export class IntegrationBus {
  private readonly plugins: IntegrationPlugin[] = [];

  register(plugin: IntegrationPlugin): void {
    this.plugins.push(plugin);
  }

  async emit(event: DomainEvent): Promise<void> {
    await Promise.all(this.plugins.map((plugin) => plugin.handle(event)));
  }
}

export interface CalendarCreateEventInput {
  requestId: string;
  idempotencyKey: string;
  entityId: string;
  summary: string;
  description?: string;
  startDateTime: string;
  endDateTime: string;
}

export type CalendarErrorCode =
  | "timeout"
  | "unauthorized"
  | "invalid_request"
  | "service_unavailable"
  | "unknown";

export type CalendarResult =
  | {
      ok: true;
      confirmationId: string;
      providerEventId?: string;
      raw?: unknown;
    }
  | {
      ok: false;
      errorCode: CalendarErrorCode;
      retryable: boolean;
      retryAfterSeconds?: number;
      raw?: unknown;
    };

export interface CalendarIntegrationAdapter {
  createEvent(input: CalendarCreateEventInput): Promise<CalendarResult>;
}

export * from "./home-assistant-calendar";
export * from "./webhook-config";
export * from "./webhook-emitter";
export * from "./rate-limiter";
export * from "./grocy-adapter";
export * from "./runtime";
export * from "./d1-adapter";
export * from "./a2a-handler";
export * from "./tool-registry";
export { fetchWithDevelopmentTls } from "./development-fetch"
