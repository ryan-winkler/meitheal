# Frontier Panel - Phase 08.1 Settings UX Iteration 01

## Objective

Polish the redesigned Settings experience so it feels like a top-tier product surface rather than a correct-but-dense refactor.

## 20 Frontier Lenses

| Lens | Recommendation | Decision |
|---|---|---|
| Nielsen heuristics | Separate “quick jump” and “directory” roles so the summary and rail stop competing | Accept |
| Norman affordance | Keep the summary strip visible in detail mode so users never lose their primary jump surface | Accept |
| Krug scanability | Replace repeated prose with short rail details and stronger section intros | Accept |
| Rams simplicity | Use one registry for summary/rail/intro copy instead of hardcoded duplicates | Accept |
| Wroblewski mobile-first | Turn mobile nav into compact quick-jumps, not squeezed desktop cards | Accept |
| Home Assistant-native lens | Preserve hash-only movement and companion-safe section ids | Accept |
| Astro-native lens | Introduce reusable Astro primitives instead of new inline-script islands | Accept |
| Accessibility keyboard lens | Add arrow-key search navigation and keep native button/anchor semantics | Accept |
| IA lens | Give section intros common-task chips so orientation is job-based, not just descriptive | Accept |
| Product trust lens | Reframe App/PWA as readiness + companion guidance, not a loose collection of controls | Accept |
| Safety lens | Make Danger Zone visually distinct without drowning it in alarm styling | Accept |
| Density lens | Replace repeated card headers and action rows with shared components | Accept |
| Search/findability lens | Add visible clear/reset and result metadata for section vs setting matches | Accept |
| Motion restraint lens | Keep subtle hover/active feedback only, no heavy new animation | Accept |
| Deep-linking lens | Keep all existing ids so hashes, tests, and save flows survive the polish pass | Accept |
| PWA lens | Keep install/troubleshoot guidance where users already expect it | Accept |
| Companion lens | Preserve `homeassistant://navigate` and x-callback-url handoffs as first-class tasks | Accept |
| Competitive parity lens | Make settings feel navigable at a glance like the best modern SaaS control surfaces | Accept |
| KCS lens | Update troubleshooting docs with the new jump/search/mobile workflow | Accept |
| HEART lens | Optimize for faster findability and lower navigation friction, not just prettier cards | Accept |
