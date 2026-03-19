# Optimization Panel - Phase 04.3 Docs Narrative Iteration 01

## Findings

| Lens | Finding | Action |
|---|---|---|
| Drift-prevention lens | Duplicated `public/` and `apps/web/public/` LLM docs were a recurring source of mismatch | Keep them synchronized in the same change set |
| Product clarity lens | README now tells a stronger story when it treats protocols as supporting surfaces, not the opening act | Keep protocol depth in dedicated docs |
| Accuracy lens | Per-surface counts were the key correction pattern for this pass | Preserve count-by-surface language in future updates |
| Transition lens | Transitional ubiquitous-language notes reduce confusion without hiding compatibility realities | Keep the compatibility note close to the vocabulary section |
| Trust lens | Screenshots and setup docs now better reinforce the Home Assistant-native story | Refresh screenshots whenever shell language changes materially |

## Open Follow-Up

1. Consider a future pass to rationalize duplicated machine-readable assets structurally, not just editorially.
2. Consider a future runtime alignment pass between Astro MCP and the HA custom-component MCP surface if product strategy wants one canonical tool surface.
