/** A2A 1.0 JSON-RPC discovery for Meitheal's synchronous task search. */
export const A2A_PROTOCOL_VERSION = "1.0"
export const A2A_TASK_SEARCH_SKILL = "task-search"

export const A2A_ERRORS = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL: -32603,
  TASK_NOT_FOUND: -32001,
  PUSH_NOT_SUPPORTED: -32003,
  UNSUPPORTED_OPERATION: -32004,
  CONTENT_TYPE_NOT_SUPPORTED: -32005,
  VERSION_NOT_SUPPORTED: -32009,
} as const

export function buildAgentCard(options: { origin: string, basePath: string, version: string }) {
  const base = options.origin + options.basePath
  return {
    name: "Meitheal",
    description: "Search active Meitheal tasks by title using a scoped token. Results are read-only.",
    supportedInterfaces: [{
      url: `${base}/api/a2a/message`,
      protocolBinding: "JSONRPC",
      protocolVersion: A2A_PROTOCOL_VERSION,
    }],
    provider: {
      organization: "Coolock Village",
      url: "https://github.com/ryan-winkler/meitheal",
    },
    version: options.version,
    documentationUrl: `${base}/openapi.yaml`,
    capabilities: {
      streaming: false,
      pushNotifications: false,
      extendedAgentCard: false,
    },
    securitySchemes: {
      meithealToken: {
        httpAuthSecurityScheme: {
          scheme: "Bearer",
          description: "A Meitheal agent token with a2a:execute and search:read.",
        },
      },
    },
    securityRequirements: [{ schemes: { meithealToken: { values: [] } } }],
    defaultInputModes: ["text/plain", "application/json"],
    defaultOutputModes: ["application/json", "text/plain"],
    skills: [{
      id: A2A_TASK_SEARCH_SKILL,
      name: "Search task titles",
      description: "Send a plain search term or a JSON object with a query property. Receive up to eight active task titles and links.",
      tags: ["tasks", "search", "read-only"],
      examples: ["heating", '{"query":"heating"}'],
    }],
  }
}
