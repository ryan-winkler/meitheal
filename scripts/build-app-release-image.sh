#!/usr/bin/env bash
set -euo pipefail

revision="$(git rev-parse HEAD)"
metadata="$(node scripts/app-release.mjs image "$CHANNEL" "$ARCHITECTURE" "$VERSION" "$revision")"
image="$(jq -er .image <<< "$metadata")"
platform="$(jq -er .platform <<< "$metadata")"
base="$(jq -er .base <<< "$metadata")"
repo="${image%:*}"

export DOCKER_CONFIG
DOCKER_CONFIG="$(mktemp -d)"
trap 'rm -rf -- "$DOCKER_CONFIG"' EXIT
printf '%s' "$GH_TOKEN" | docker login ghcr.io --username "$GITHUB_ACTOR" --password-stdin

existing=false
if docker manifest inspect "$image" > /dev/null 2>"$DOCKER_CONFIG/manifest-error"; then
  docker pull --platform "$platform" "$image"
  existing=true
elif grep -Eq '^(manifest unknown|no such manifest:)' "$DOCKER_CONFIG/manifest-error"; then
  docker buildx build --load --platform "$platform" \
    --file meitheal-hub/Dockerfile --build-arg "BUILD_FROM=$base" --build-arg "MEITHEAL_VERSION=$VERSION" \
    --label "org.opencontainers.image.source=https://github.com/ryan-winkler/meitheal" \
    --label "org.opencontainers.image.revision=$revision" \
    --label "org.opencontainers.image.version=$VERSION" \
    --label "org.opencontainers.image.licenses=LicenseRef-Meitheal-Source-Available-1.0" \
    --label "io.hass.version=$VERSION" --label "io.hass.arch=$ARCHITECTURE" \
    --tag "$image" .
else
  cat "$DOCKER_CONFIG/manifest-error" >&2
  exit 1
fi

bash scripts/smoke-app-release-image.sh docker "$image" "$revision" "$ARCHITECTURE" "$platform" "$VERSION"

if [[ "$existing" == true ]]; then
  digest="$(docker image inspect --format '{{join .RepoDigests "\n"}}' "$image" | awk -v repo="$repo" 'index($0, repo "@") == 1 {print substr($0, length(repo) + 2)}')"
else
  docker push "$image" | tee "$DOCKER_CONFIG/push-log"
  digest="$(awk '/digest: sha256:/ {for (i = 1; i < NF; i++) if ($i == "digest:") print $(i + 1)}' "$DOCKER_CONFIG/push-log")"
fi
[[ "$digest" =~ ^sha256:[0-9a-f]{64}$ ]]
printf 'image=%s\ndigest=%s\n' "$image" "$digest" >> "$GITHUB_OUTPUT"
