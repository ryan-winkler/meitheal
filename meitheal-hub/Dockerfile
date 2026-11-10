# ── Global build args ──
# BUILD_FROM is passed by HA Supervisor/build.json. Keep a valid local default so
# Docker tooling and GitHub annotations do not treat the runtime FROM as empty.
ARG BUILD_FROM=ghcr.io/home-assistant/amd64-base:3.23

# ── Stage 1: Build ──
# Pinned to $BUILDPLATFORM (host arch) to avoid QEMU crashes on aarch64 cross-builds.
# Output is pure JS — no native addons — so build artifacts are arch-independent.
# Layer order is optimised for Docker cache: deps change less often than source.
FROM --platform=$BUILDPLATFORM node:22-alpine3.23 AS builder

RUN npm install -g pnpm@10.8.0

WORKDIR /build

# Layer 1: Dependency manifests + config (changes rarely → cached most builds)
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY apps/web/package.json apps/web/package.json
COPY packages/ packages/

# Layer 2: Install all deps (cached when lockfile + manifests unchanged)
RUN pnpm install --frozen-lockfile --ignore-scripts

# Layer 3: Source code (changes every build, but deps are already cached above)
COPY apps/web/ apps/web/
COPY integrations/ integrations/
COPY meitheal-hub/ meitheal-hub/
COPY README.md AGENTS.md ./

# Layer 4: Build the Astro app
RUN pnpm --filter @meitheal/web build

# ── Stage 2: Runtime ──
# Lean HA add-on image with only production artifacts.
FROM ${BUILD_FROM}

LABEL io.hass.type="addon"
LABEL org.opencontainers.image.licenses="LicenseRef-Proprietary"

RUN apk add --no-cache nodejs npm curl ca-certificates bash
RUN npm install -g pnpm@10.8.0

WORKDIR /opt/meitheal

# Copy monorepo scaffolding
COPY --from=builder /build/pnpm-workspace.yaml /build/pnpm-lock.yaml /build/package.json ./
COPY --from=builder /build/packages/ packages/
COPY --from=builder /build/apps/web/package.json apps/web/package.json

# Copy built output from builder stage
COPY --from=builder /build/apps/web/dist apps/web/dist/

# Copy migration scripts and SQL files needed at runtime
COPY --from=builder /build/apps/web/scripts/ apps/web/scripts/
COPY --from=builder /build/apps/web/drizzle/ apps/web/drizzle/

# Copy HA custom component for auto-install
COPY --from=builder /build/integrations/home-assistant/custom_components/ /opt/meitheal/custom_components/

# Install production deps only
RUN pnpm install --frozen-lockfile --ignore-scripts --prod \
    && pnpm store prune

# Copy entrypoints from builder (not from build context)
COPY --from=builder /build/meitheal-hub/run.sh /run.sh
COPY --from=builder /build/meitheal-hub/run-local.sh /run-local.sh
RUN chmod +x /run.sh /run-local.sh

# Copy rootfs overlay (backup scripts, service definitions)
COPY --from=builder /build/meitheal-hub/rootfs/ /

# Ensure data directory exists
RUN mkdir -p /data

# NOTE: HA addons run as root — Supervisor-managed /data volume requires root
# access on fresh installs. This follows the hassio-addons convention.

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD curl -fsS http://127.0.0.1:3000/api/health || exit 1

# NOTE: No CMD — s6-overlay (PID 1 in HA base images) discovers
# /etc/services.d/meitheal/run which exec's /run.sh.
# Adding CMD would cause a double-start since s6 runs both
# services.d longrun processes AND the CMD concurrently.
