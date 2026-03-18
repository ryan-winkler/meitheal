# GitHub Copilot Instructions for Meitheal

> These instructions apply to all GitHub Copilot features in this repository:
> Copilot Chat, code completion, and the Copilot Coding Agent.

## Commit Authorship

**Do not publish commits under the Copilot bot identity.**

Every commit produced by an AI agent in this repository **must** include a
`Co-authored-by` trailer that credits the human owner:

```
Co-authored-by: ryan-winkler <ryan-winkler@users.noreply.github.com>
```

The preferred approach is a **squash-merge** of any agent-created PR so that
the final commit lands under the human author's identity. Do not push
force-authored commits directly to `main`.

## Coding Standards

Refer to `AGENTS.md` and the inline docs for full conventions. Key points:

- No semicolons, double-quoted strings, 2-space indent (TypeScript/Astro)
- Named exports only — no default exports
- kebab-case filenames, PascalCase types, camelCase functions
- Discriminated unions for API responses: `{ ok: true } | { ok: false, errorCode }`
- Do not introduce new external dependencies without security-advisory check

## Architecture Constraints

- Preserve Astro-first SSR architecture
- Maintain DDD bounded-context boundaries (no cross-context deep imports)
- Keep Home Assistant add-on compatibility as a first-class constraint
- Never issue server-side redirects to bare `/` paths behind HA ingress
