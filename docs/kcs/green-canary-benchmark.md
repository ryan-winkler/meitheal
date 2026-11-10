---
type: "Runbook"
title: "Green Canary Benchmark"
description: "Collect and validate the versioned Green release workload and driver evidence."
---

# Green Canary Benchmark

`green-2000-task-v2` is the release minimum for the Astro SSR App. It measures raw, total App `memory.current`: idle p95 must be **below 128 MiB** and active p95 **below 160 MiB**, inside a **192 MiB hard cgroup cap**. The earlier 64/96 MiB figures remain optimization goals, not a second qualification mode or an additional release gate. Do not subtract page cache, driver memory, or selected process measurements from the App's total.

The active App CPU mean remains at most **15% of one core**, and each route's nearest-rank p95 remains at most **350 ms**. Keep one CPU, zero swap, the existing App sampling, 12 idle samples, and at least 50 active samples spaced 5–8 seconds apart. The active sample window must still match the driver wall time within eight seconds.

## Fixed workload and helper

The workload is unchanged except for the already measured response-file directory change to `/dev/shm`. It seeds exactly 2,000 synthetic tasks, then runs 105 ordered cycles: Today, List, Search, Open, Create, Complete, Readback. That is 735 complete HTTP responses plus 105 sleeps of 2.5 seconds. `curl` still waits for each complete response body; the existing ID and completion-state body assertions still run against the retained response file. No source App or runtime change is part of this profile.

The two public scripts are pinned byte-for-byte:

| Script | SHA-256 |
|---|---|
| `scripts/green-canary-workload.sh` | `d060f566d2ab6c8a90537b21f049cc1215b97ea9328e23e428b56aa1246fa50b` |
| `scripts/green-canary-driver-parent.sh` | `60b394f364c7f43a0038c0fb4376abd1a435a1760cf2bcd7ca29404e12ea6869` |

Use the existing immutable ARM64 helper config `sha256:5ce98efbe0fdb68edf92f3b98dfe78a70739a412d76083a42bfefbde8410824f`, architecture `arm64`, with layer `sha256:5070b31eb4c50bf7d0297a1a5aee25bc13ff29894e87354610f6b8b6a445e07e`. Do not replace it with a mutable tag or the candidate App image. Keep the existing separate seed/driver cgroups, shared probe loopback namespace and disposable data volume. Existing seed limits remain unchanged; the measured driver stays at **80 MiB, one CPU and zero swap**.

Changing either script or the helper identity requires a reviewed profile change. A matching source version or generous memory reading cannot compensate for a different workload, missing telemetry or an unknown profile.

## Driver collection

The existing operator launcher copies the workload as `seed-and-run.sh`, calculates its checksum, and supplies it on stdin to the pinned parent program. The parent runs `bash -s -- "$@"` with the unchanged version, `run`, and `105` arguments. Keep the container command's exit status and both stdout and stderr before cleanup; independently require exit status zero.

The parent uses Bash builtins to read monotonic `/proc/uptime` before/after the child, plus integer `user_usec` and `system_usec` cgroup counter deltas. It formats one three-field `driver_seconds,wall,user,system` record with three decimal places. Wall time uses uptime centiseconds; CPU deltas are truncated to milliseconds. There is no Bash `%U`/`%S` timing and no extra Node telemetry process.

Before `--rm` can remove the cgroup, the surviving parent reads and emits its actual `memory.max`, `memory.swap.max`, `memory.swap.current`, `cpu.max`, and final `max`, `oom`, `oom_kill` counters. These must match 80 MiB, zero swap, one CPU and zero events. `oom_group_kill` must be zero when present; `absent` is accepted only for that optional kernel field. Missing, malformed, duplicate or nonzero required data fails. A failed child keeps its nonzero exit status; a successful child with invalid telemetry exits 125. A killed parent that emits no final receipt cannot qualify.

## Receipt contract

Start a new raw receipt with `benchmark_profile=green-2000-task-v2`. Retain exactly one `seed_and_driver_script_sha256=` record and one `driver_parent_script_sha256=` record with the hashes above, plus their checksum-command output. The workload checksum line must end in `/seed-and-run.sh`; the parent line must end in `/green-canary-driver-parent.sh` or `/driver-parent-wrapper.sh`.

Keep the existing exact App config ID, source version, helper identity, health, seed count, resource limits, samples, ordered response records and unchanged installed-Canary identity. After the measured HTTP/sample records, the terminal order is:

1. `workload,completed,105`
2. `driver_clock,v1,...` with monotonic uptime centiseconds and user/system microsecond snapshots
3. `driver_seconds,...`, numerically matching those counter deltas
4. `driver_cgroup_receipt,v1,...`, reporting successful child and valid final limits/events
5. The App's final `max`, `oom`, `oom_kill` lines, final healthy probe and unchanged installed Canary
6. `probe_cleanup=complete`, as the final nonempty line

Validate the complete receipt with `python3 scripts/verify-canary-green.py --report RECEIPT CONFIG_ID VERSION`. CPU and route checks are unchanged. The report exposes raw total-memory p95/max and nearest-rank tail metrics; it does not convert older receipts into qualification evidence.

`--driver-only` checks isolated helper timing/cgroup evidence without image/version arguments. It never authorizes Green qualification or publication. The full release invocation requires the complete profile and workload evidence.

## Failed and historical evidence

Preserve earlier failed receipts, scripts and checksums. Original and R3 receipts without this profile and final driver telemetry remain rejected, even when their memory values would fit the new minimum. Malformed historical timing such as `11.:00` remains invalid. Do not repair old raw CSV, attach new telemetry to an old run, or relabel a diagnostic result as passing. Run a new physical benchmark after the reviewed source and profile are adopted.

Run `pnpm --filter @meitheal/tests test governance/canary-green-receipt.spec.ts` for deterministic boundaries, tampering and publication fail-closed checks. Short isolated AMD64 helper tests can verify normal child completion, failed child status and cgroup-event rejection using the installed immutable AMD64 counterpart; those tests are not a Green run. Preserve their raw output and confirm their owned containers were removed. Physical Green operation and source/image promotion remain separate, explicitly authorized steps.
