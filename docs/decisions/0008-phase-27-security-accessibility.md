---
type: "Decision"
title: "ADR-0008: Phase 27 Security & Accessibility Hardening"
description: "Records security and accessibility decisions for the affected release."
---

# ADR-0008: Phase 27 Security & Accessibility Hardening

- **Status**: Accepted
- **Date**: 2026-02-28
- **Context**: Phase 27 GSD mega-sweep across 10 domains (40 iterations)

## Decision

### Security

1. **CSRF Protection**: Origin-based checking on all mutating API routes (POST/PUT/DELETE/PATCH). Checks Origin/Referer against Host header. Skipped in dev mode. Allows no-origin requests (curl, HA internal).
2. **CSP Tightening**: Added `base-uri 'self'`, `form-action 'self'`, `upgrade-insecure-requests`, `blob:` for img-src. Kept `unsafe-inline` for Astro hydration compatibility.
3. **Settings API**: Key format validation (alphanumeric/hyphen/underscore, 100 char max), value size limit (10KB).
4. **Import Safety**: 100KB body size guard, expanded allowlist for Phase 26 keys, `updated_at` field on upsert.

### Accessibility

1. **Toast `aria-live`**: All 5 toast containers now have `aria-live="polite"` and `role="status"` per VPAT 4.1.3.
2. **Reduced Motion**: Global `prefers-reduced-motion: reduce` disables all animation-duration, transition-duration, and scroll-behavior per VPAT 2.2.2.
3. **Heading Hierarchy**: Layout provides `<h1>` via slot, all pages fill it correctly.

### Performance

1. **DB Indexes**: Added `task_type`, `created_at`, `due_date` indexes (8 total).
2. **Kanban persistence**: Group-by mode saved to localStorage.

## Consequences

- All mutating API routes now require same-origin requests in production
- Users with vestibular disorders get zero-animation experience
- Screen readers announce toast messages via live regions
- Sort/filter queries benefit from B-tree indexes on 8 columns
