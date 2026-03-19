# WebMCP and A2A Setup

This guide explains the current agent-facing protocol surfaces in Meitheal and how to talk about them accurately.

## Current status

| Surface | Status | Notes |
|--------|--------|-------|
| A2A | Live, lightweight | Dynamic agent card and message routes are available |
| Astro MCP | Live | 18 tools in the Astro app |
| Home Assistant MCP | Live | 16 tools via the custom component |
| WebMCP | Experimental | Product direction documented, runtime browser registration not broadly active yet |

## A2A

### Routes

```text
GET  /api/a2a/agent-card
POST /api/a2a/message
GET  /api/a2a/tasks/{id}
POST /api/a2a/tasks/{id}:cancel
```

### Static discovery

- `/.well-known/agent-card.json`

### Dynamic skill model

The dynamic agent card exposes 9 core skills:

- task management
- task search
- framework scoring
- data export
- areas
- labels
- today summary
- habits
- weekly review

When Home Assistant is configured, 2 HA skills are added:

- calendar sync
- entity state

### Important limitation

The message route is live, but task-status and cancel routes currently return lightweight scaffolded task objects rather than persisted long-running task state.

## Astro MCP

Use:

```text
POST /api/mcp
GET  /.well-known/mcp.json
```

Astro MCP currently exposes 18 tools. See `WEBMCP.md` or `llms-full.txt` for the full verified list.

## Home Assistant MCP

The Home Assistant custom component exposes a separate 16-tool MCP surface. It overlaps with Astro MCP but is not identical.

Do not collapse the two into one shared count in user docs.

## WebMCP

WebMCP remains experimental.

Treat it as:

- a documented forward-looking browser-agent surface
- a place for product exploration
- not a mainstream shipped runtime feature on stable browsers today

## References

- `WEBMCP.md`
- `public/llms-full.txt`
- `integrations/home-assistant/custom_components/meitheal/README.md`
