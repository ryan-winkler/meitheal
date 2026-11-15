# ── Global build args ──
# BUILD_FROM is passed by HA Supervisor/build.json. Keep a valid local default so
# Docker tooling and GitHub annotations do not treat the runtime FROM as empty.
ARG BUILD_FROM=ghcr.io/home-assistant/amd64-base:3.23

# ── Stage 1: Build ──
# Pinned to $BUILDPLATFORM (host arch) to avoid QEMU crashes on aarch64 cross-builds.
# Output is pure JS — no native addons — so build artifacts are arch-independent.
# Layer order is optimised for Docker cache: deps change less often than source.
# Dependabot keeps the tag and digest current together.
FROM --platform=$BUILDPLATFORM node:26-alpine3.23@sha256:39d8c143e60e99ae98f014bebea1e72fc96d3c9bdf9504bc3a27af5c05bfa39f AS builder

# pnpm comes from a lockfile with an integrity hash, not a floating npm install.
COPY meitheal-hub/toolchain/package.json meitheal-hub/toolchain/package-lock.json /opt/toolchain/
RUN npm ci --prefix /opt/toolchain --ignore-scripts --no-audit --no-fund \
    && ln -s /opt/toolchain/node_modules/.bin/pnpm /usr/local/bin/pnpm

WORKDIR /build

# Layer 1: Dependency manifests + config (changes rarely → cached most builds)
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY apps/web/package.json apps/web/package.json
COPY packages/domain-auth/package.json packages/domain-auth/
COPY packages/domain-observability/package.json packages/domain-observability/
COPY packages/domain-strategy/package.json packages/domain-strategy/
COPY packages/domain-tasks/package.json packages/domain-tasks/
COPY packages/integration-core/package.json packages/integration-core/

# Layer 2: Install all deps (cached when lockfile + manifests unchanged)
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --ignore-scripts

# Layer 3: Source code (changes every build, but deps are already cached above)
COPY packages/ packages/
COPY apps/web/ apps/web/
COPY meitheal-hub/ meitheal-hub/

# Layer 4: Build the Astro app
ARG MEITHEAL_VERSION
RUN pnpm --filter @meitheal/web build

# ── Stage 2: Production dependencies for the target platform ──
FROM ${BUILD_FROM} AS runtime-deps

RUN apk add --no-cache nodejs
COPY --from=builder /opt/toolchain/ /opt/toolchain/
RUN ln -s /opt/toolchain/node_modules/.bin/pnpm /usr/local/bin/pnpm

WORKDIR /opt/meitheal

COPY --from=builder /build/pnpm-workspace.yaml /build/pnpm-lock.yaml /build/package.json ./
COPY --from=builder /build/packages/ packages/
COPY --from=builder /build/apps/web/package.json apps/web/package.json

RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm --filter @meitheal/web... install --frozen-lockfile --ignore-scripts --prod

# ── Stage 3: Runtime ──
# s6-overlay starts as root to prepare the Supervisor /data volume, then drops
# privileges via s6-setuidgid meitheal in /run.sh.
# nosemgrep: dockerfile.security.missing-user.missing-user
FROM ${BUILD_FROM}

LABEL io.hass.type="addon"
LABEL org.opencontainers.image.licenses="LicenseRef-Proprietary"
ARG MEITHEAL_VERSION
ENV MEITHEAL_VERSION=$MEITHEAL_VERSION

RUN apk add --no-cache nodejs curl ca-certificates bash 'zlib>=1.4-r0'

WORKDIR /opt/meitheal

COPY LICENSE NOTICE ./
COPY --from=runtime-deps /opt/meitheal/ ./
COPY --from=builder /build/apps/web/dist apps/web/dist/
COPY --from=builder /build/apps/web/scripts/ apps/web/scripts/
COPY --from=builder /build/apps/web/drizzle/ apps/web/drizzle/

# Copy entrypoints from builder (not from build context)
COPY --from=builder /build/meitheal-hub/run.sh /run.sh
COPY --from=builder /build/meitheal-hub/run-local.sh /run-local.sh
RUN chmod +x /run.sh /run-local.sh

# Copy rootfs overlay (backup scripts, service definitions)
COPY --from=builder /build/meitheal-hub/rootfs/ /

# s6 starts as root to prepare the Supervisor volume. The App processes
# use the same service UID and GID on both supported architectures.
RUN addgroup -S -g 10001 meitheal \
    && adduser -S -D -H -h /data -s /sbin/nologin -u 10001 -G meitheal meitheal \
    && mkdir -p /data

# nosemgrep: dockerfile.security.missing-user.missing-user
HEALTHCHECK --interval=30s --timeout=5s --start-period=45s --retries=3 \
  CMD curl -fsS http://127.0.0.1:3000/api/health || exit 1

# NOTE: No CMD — s6-overlay (PID 1 in HA base images) discovers
# /etc/services.d/meitheal/run which exec's /run.sh.
# Adding CMD would cause a double-start since s6 runs both
# services.d longrun processes AND the CMD concurrently.
