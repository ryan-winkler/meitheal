# Optimization Panel — Phase 16 Iteration 03

## Code Review Findings

| # | Category | Finding | Impact | Effort | Risk |
|---|----------|---------|:---:|:---:|:---:|
| O1 | Memory | `setupBarDrag` adds `mousemove`/`mouseup` listeners to `document` **without AbortSignal** — leaks on re-render (zoom switch). Each zoom change adds N×2 permanent listeners. | 5 | 2 | 3 |
| O2 | Security | `showTooltip` uses `innerHTML` with `sanitize()` but could be pure DOM like `showPopup`. Defence-in-depth. | 3 | 1 | 1 |
| O3 | A11y | No `prefers-reduced-motion` check — FAB pulse animation, toast transitions, and hover scale run regardless. | 3 | 1 | 1 |
| O4 | UX | Bar drag produces **cumulative position drift** — each `onMove` reads current `x` and adds `dx`, but `dragStartX` resets each frame, causing rects and text to compound movement. Need delta-from-origin approach. | 5 | 3 | 2 |
| O5 | UX | Resize `onMove` handler only sets `document.body.cursor` but doesn't visually update the bar width. User gets no visual feedback during resize drag. | 4 | 3 | 2 |
| O6 | UX | After drag/resize, bar position visually updates but doesn't re-render. If the PATCH changes dates, the chart should re-render to snap to grid. | 4 | 2 | 2 |
| O7 | Perf | `renderGantt` creates N clip paths in `<defs>` but doesn't namespace them — could conflict on re-render since defs persist. Cleared by `innerHTML = ""` but fragile. | 2 | 1 | 1 |
| O8 | A11y | Bars have `tabindex: 0` but no keyboard `Enter`/`Space` handler to trigger popup. Focus ring style exists in CSS but no keyboard interaction. | 3 | 1 | 1 |

## Action Plan

1. **O1**: Pass `signal` to `setupBarDrag`, use `{ signal }` on document listeners
2. **O2**: Convert `showTooltip` from innerHTML to DOM-based construction  
3. **O3**: Check `prefers-reduced-motion` before running animations
4. **O4**: Fix drag to use origin-relative delta instead of frame-relative delta
5. **O5**: Add visual bar width update during resize drag
6. **O6**: Re-render chart after successful drag/resize PATCH
7. **O7**: No action — `innerHTML=""` already cleans up, low risk
8. **O8**: Add `keydown` handler for Enter/Space on bar groups and milestones
