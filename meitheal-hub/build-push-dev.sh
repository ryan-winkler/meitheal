#!/bin/bash
# Meitheal Hub — Build and push to GitHub Container Registry for dev testing on HA Green
#
# Prerequisites:
#   docker login ghcr.io -u ryan-winkler  (use a PAT with write:packages)
#
# Usage:
#   ./meitheal-hub/build-push-dev.sh          # builds amd64 + aarch64, pushes :dev
#   ./meitheal-hub/build-push-dev.sh 0.0.1    # builds and pushes :0.0.1
#
# After pushing, on your HA Green:
#   1. Go to Settings → Add-ons → Add-on Store → ⋮ → Repositories
#   2. Add: https://github.com/ryan-winkler/meitheal-ha-addon
#   3. Find "Meitheal" → Install → Start → Open Web UI
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP_VERSION="$(sed -n 's/^version: "\(.*\)"$/\1/p' "${REPO_ROOT}/meitheal-hub/config.yaml")"
REGISTRY="ghcr.io/ryan-winkler"
IMAGE_BASE="${REGISTRY}/meitheal"
TAG="${1:-dev}"

echo "=== Meitheal Hub — Docker Build & Push ==="
echo "Tag: ${TAG}"
echo "Version: ${APP_VERSION}"
echo "Repo: ${REPO_ROOT}"
echo ""

# Ensure buildx is available
docker buildx create --name meitheal-builder --use 2>/dev/null || docker buildx use meitheal-builder

for ARCH in amd64 aarch64; do
  PLATFORM="linux/amd64"
  BUILD_FROM="ghcr.io/home-assistant/${ARCH}-base:3.23"

  if [ "${ARCH}" = "aarch64" ]; then
    PLATFORM="linux/arm64"
  fi

  IMAGE="${IMAGE_BASE}-${ARCH}"
  echo "──── Building ${IMAGE}:${TAG} (${PLATFORM}) ────"

  docker buildx build \
    --platform "${PLATFORM}" \
    --build-arg BUILD_FROM="${BUILD_FROM}" \
    --build-arg MEITHEAL_VERSION="${APP_VERSION}" \
    -f "${REPO_ROOT}/meitheal-hub/Dockerfile" \
    -t "${IMAGE}:${TAG}" \
    --push \
    "${REPO_ROOT}"

  echo "✅ ${IMAGE}:${TAG} pushed"
done

echo ""
echo "=== Done! ==="
echo ""
echo "To install on HA Green:"
echo "  1. Settings → Add-ons → Add-on Store → ⋮ → Repositories"
echo "  2. Add: https://github.com/ryan-winkler/meitheal-ha-addon"
echo "  3. Find 'Meitheal' → Install → Start"
echo ""
echo "To update after code changes, re-run this script and restart the add-on in HA."
