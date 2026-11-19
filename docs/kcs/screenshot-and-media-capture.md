---
type: "Runbook"
title: "Screenshot and Media Capture"
description: "Regenerate README screenshots and local feature demos from a clean production build."
---

# Screenshot and Media Capture

Use [the capture script](../../scripts/capture-marketing-media.mjs) to regenerate `README.md` screenshots and local feature animations against the real production Astro build without exposing personal household data or Astro dev-toolbar overlays.

## Prerequisites

Install workspace dependencies, build the web server, verify Chromium is available for Playwright, and confirm `ffmpeg` and `ffprobe` are on `PATH` (no extra npm image libraries are required; `sharp` is not used):

```sh
pnpm install --frozen-lockfile
pnpm --filter @meitheal/web build
pnpm --filter @meitheal/tests exec playwright install chromium
ffmpeg -version && ffprobe -version
```

## Commands

Generate only the static PNG stills and update `docs/screenshots/`:

```sh
node scripts/capture-marketing-media.mjs --stills-only --update-readme
```

Generate all 10 PNG stills, 5 CDP feature loops (`.mp4` + `.gif`), and the stitched launch highlight reel, syncing the 6 `README.md` stills to `docs/screenshots/`:

```sh
node scripts/capture-marketing-media.mjs --update-readme
```

Pass `--out <dir>` to write artifacts outside the default `.planning/marketing/media` directory, or `--base-url <url>` to capture an already-running server instance.

## Isolation and Determinism

Each run keeps host and developer data separate from generated media:

1. **Isolated SQLite fixture**: Creates a temporary SQLite database in `os.tmpdir()` and initializes its schema with `apps/web/scripts/migrate.mjs` (`MEITHEAL_DB_URL=file:<tmp>/meitheal.db`).
2. **Production Astro server**: Spawns `apps/web/scripts/serve.mjs` with `NODE_ENV=production` and `TZ=Europe/Dublin`, stripping Home Assistant or cloud environment credentials and restarting cleanly between seeding and capture loops to keep the 300 req/min rate-limit bucket clear.
3. **Synthetic household seed**: Populates invented household tasks, routines, multi-day Gantt schedules, promoted cards, and Home Assistant automation fixtures (`X-Automation-Source: ha`), locking `theme` to `"dark"` (`Emerald Isle`) before capture.

## Repository Hygiene and Size Budgets

Keep tracked repository artifacts minimal while storing heavy animations locally:

| Output | Location | Git & Docker Status | Size / Format Budget |
|---|---|---|---|
| Capture automation | `scripts/capture-marketing-media.mjs` | Tracked in Git | Zero runtime dependencies outside Playwright + `ffmpeg` |
| `README` & add-on stills | `docs/screenshots/{today,dashboard,kanban,table,calendar,settings}.png` | Tracked in Git (`brand-banner.png` kept untouched) | `1440×900` (`300 KB` max per file via lossless scale + palette fallback) |
| Campaign bonus stills | `.planning/marketing/media/stills/{timeline,focus-mode,eisenhower,mobile-today}.png` | Ignored (`.gitignore` & `.dockerignore`) | Up to `400 KB` (`390×844` for mobile) |
| Feature motion loops | `.planning/marketing/media/loops/*.{mp4,gif}` | Ignored (`.gitignore` & `.dockerignore`) | `<= 2.8 MB` Discourse GIF ladder; `1280×720` H.264 High 4.1 MP4 |
| Stitched highlight reel | `.planning/marketing/media/reddit/meitheal-launch-reel.mp4` | Ignored (`.gitignore` & `.dockerignore`) | `h264` `yuv420p` 30fps + stereo AAC + `+faststart` |

`meitheal-hub/README.md` and `meitheal-hub-canary/README.md` reference `docs/screenshots/brand-banner.png`, `today.png`, and `kanban.png` directly from `dev`. Always visually inspect updated `docs/screenshots/*.png` files before pushing. Working notes, progress logs, launch drafts, and heavy media belong under `.planning/` (never under `docs/` or `apps/web/public/`).

## Verification and Troubleshooting

After updating screenshots, verify OKF documentation rules, repo standards, and tracked diff scope:

```sh
pnpm --filter @meitheal/tests test governance/docs-okf.spec.ts governance/repo-standards.spec.ts
git status --short
```

| Symptom | Cause & Recovery |
|---|---|
| `Missing production build at .../dist/server/entry.mjs` | Run `pnpm --filter @meitheal/web build` before invoking the script. |
| `Database does not exist. Run the migration command` | Fixed automatically when not using `--base-url`; with `--base-url`, run `node apps/web/scripts/migrate.mjs` against your target DB first. |
| `HTTP 429 Rate limit exceeded` | Avoid running against a busy persistent server without `--base-url`; default mode restarts the local server between batches. |
| `PNG ... exceeding cap 300000` or `GIF ... exceeding 2800000` | Trim hold durations in `captureLoops` or verify `ffmpeg` supports `palettegen`/`paletteuse`. |
