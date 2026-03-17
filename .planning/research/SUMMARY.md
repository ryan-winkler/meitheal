# Research Summary: Settings Navigation Fix

**Domain:** Settings page navigation layout in HA add-on  
**Researched:** 2026-03-17  
**Overall confidence:** HIGH

## Executive Summary

The settings page navigation has four interconnected layout issues stemming from one root cause: the sticky tab bar operates in viewport coordinates (position:fixed) without accounting for the app shell's spatial hierarchy (sidebar, topbar). This causes the tab bar to cover the sidebar logo, occlude the search bar, and let tabs silently overflow without affordance.

Zendesk's unified navigation (GA April 2026) provides the reference pattern. Their approach uses: (1) an icon-only sidebar collapse mode (~48px) instead of fully sliding off-screen, (2) a persistent expand/collapse toggle at the sidebar bottom, (3) consistent search field placement that is never occluded, and (4) an overflow options menu for tabs that prevents compression to unreadable widths. These patterns are proven at scale across Zendesk's product suite (Support, Admin Center, Explore, Sell).

The fix decomposes into two priority tiers. **P0**: Fix tab bar positioning (z-index, offsets) and implement dynamic overflow tabs with a "More" dropdown. **P1**: Convert sidebar collapse from off-screen slide to Zendesk-style icon-only mode with persistent toggle. P0 can be shipped immediately; P1 is a separate follow-up.

## Key Findings

**Architecture:** Tab bar uses `position:fixed; top:0; left:0; z-index:100` ignoring sidebar (fixed, z-40, 240px) and topbar (sticky top-0, z-30). Fix: offset by sidebar width and topbar height, lower z-index to 35.

**Features:** Dynamic overflow tabs (ResizeObserver-based) is the de facto standard — used by Zendesk, Chrome DevTools, Atlassian, iOS UITabBarController. Must include ARIA `aria-expanded`, keyboard navigation, overflow tab count badge.

**Pitfalls:** HA ingress breaks CSS position:sticky (already mitigated via IntersectionObserver fallback). ResizeObserver measurements during CSS transitions give wrong values (mitigate with rAF debounce).

## Implications for Roadmap

### P0: Tab Bar Fixes (single implementation pass)

1. **Z-index fix** — Change z-100 → z-35 in `.is-fixed` CSS ✅ Already done
2. **Position offsets** — `top: topbar.bottom`, `left: sidebarOffset` ✅ Already done
3. **Dynamic overflow tabs** — New `initOverflowTabs()` function:
   - ResizeObserver on tab container
   - Measure each tab width, determine fit count
   - "⋯ More" button with dropdown for hidden tabs
   - Active tab always visible (swap if needed)
   - ARIA: `aria-expanded`, `role="menu"`, keyboard nav
   - CSS: overflow dropdown styles ✅ Already added to settings.astro

### P1: Sidebar Zendesk-Style Collapse (follow-up)

4. **Icon-only sidebar mode** — 48px width, icons visible, labels hidden
5. **Persistent toggle** — Always visible at sidebar bottom, `«`/`»` chevron
6. **Sidebar tooltips** — Icon tooltips in collapsed mode
7. **State persistence** — localStorage for expanded/collapsed preference

**Phase ordering rationale:** P0 fixes broken UX immediately. P1 enhances UX but current sidebar toggle works (just poorly discoverable).

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| Tab position fix | HIGH | Root cause confirmed via code audit |
| Overflow tabs pattern | HIGH | Zendesk article + Chrome DevTools + Atlassian all use same pattern |
| Sidebar icon-only | HIGH | Zendesk article explicitly documents this pattern |
| HA ingress compatibility | MEDIUM | IntersectionObserver workaround tested, position:fixed works |

## Gaps to Address

- RTL layout support (future — use `inset-inline-start` instead of `left`)
- Sidebar icon-only mode needs thorough mobile testing at 768px breakpoint
- "More" dropdown dismiss-on-scroll behavior needs testing in HA ingress iframe

## Sources

- [Zendesk Unified Navigation EAP](https://support.zendesk.com/hc/en-us/articles/9562911580570) — PRIMARY reference
- User-provided Zendesk screenshots (5 images) — design reference
- 50-persona panel audit (50 experts across UX, a11y, CSS, HA) — validation
- Web research: ResizeObserver overflow tabs 2025 — implementation patterns
- Codebase audit: `settings-shell-controller.ts`, `_layout.css`, `settings.astro`
