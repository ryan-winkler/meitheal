# Optimization Panel — Phase 16.3-16.4 (Filter Row & Customize Panel)

## Post-Implementation Review

| # | Category | Finding | Impact | Effort | Risk | Action |
|---|----------|---------|:---:|:---:|:---:|--------|
| F1 | Memory | CardCustomizer uses `astro:page-load` without AbortSignal — density btn, close, and reset listeners accumulate on soft nav | 4 | 2 | 2 | Fix — use AbortController |
| F2 | A11y | Density buttons have `role="radiogroup"` parent but buttons lack `role="radio"` + `aria-checked` | 3 | 1 | 1 | Fix |
| F3 | UX | Fields panel has no transition on open/close — abrupt display toggle | 2 | 1 | 1 | Fix — CSS transition |
| F4 | Code | `renderFieldList` uses `innerHTML = ""` — could use `replaceChildren()` | 1 | 1 | 1 | Fix |
| F5 | UX | Panel renders left-aligned below signal bar; ideally right-aligned near Fields button | 3 | 3 | 2 | Defer — requires layout restructure |

## Action Plan

1. **F1**: Add AbortController to CardCustomizer init, abort on re-init
2. **F2**: Add `role="radio"`, `aria-checked` to density buttons
3. **F3**: Add CSS transition to `.kanban-fields-panel`
4. **F4**: Replace `innerHTML = ""` with `replaceChildren()`
5. **F5**: Deferred — needs design consideration for right-aligned panel
