#!/usr/bin/env bash
set -euo pipefail

fail() { printf '%s\n' "$*" >&2; exit 1; }

case "${1:-}:$#" in
  build:2|publish:6|stage:7|promote:6) ;;
  *)
    fail 'Usage: publish-canary-local.sh build ARCH | promote AMD64_IMAGE_ID ARM64_IMAGE_ID GHCR_USER APP_CHECKOUT GREEN_RECEIPT | publish ARCH IMAGE_ID GHCR_USER ARM64_IMAGE_ID GREEN_RECEIPT | stage AMD64_DIGEST AMD64_IMAGE_ID ARM64_DIGEST ARM64_IMAGE_ID APP_CHECKOUT GREEN_RECEIPT'
    ;;
esac

# Resolve the operator's receipt path before switching to the source checkout.
if [[ "$1" != build ]]; then
  [[ -f "${!#}" && -r "${!#}" ]] || fail 'Expected a readable raw Green receipt file'
  receipt="$(realpath -e -- "${!#}")"
fi
cd "$(git rev-parse --show-toplevel)"
[[ -z "$(git status --porcelain)" ]] || fail 'Use a clean source checkout'
revision="$(git rev-parse HEAD)"
source_ref="${CANARY_SOURCE_REF:-}"
if [[ -z "$source_ref" ]]; then
  branch="$(git symbolic-ref --quiet --short HEAD 2>/dev/null || true)"
  case "$branch" in
    dev|main) source_ref="refs/heads/$branch" ;;
    *) source_ref="refs/heads/dev" ;;
  esac
fi
[[ "$source_ref" == refs/heads/dev || "$source_ref" == refs/heads/main ]] ||
  fail 'Canary source ref must be refs/heads/dev or refs/heads/main'
source_branch="${source_ref#refs/heads/}"
version="$(node scripts/app-release.mjs prepare canary workflow_dispatch "$source_ref" "$revision")"
version="${version#version=}"

current_source_ref() {
  gh api --hostname github.com "repos/ryan-winkler/meitheal/git/ref/heads/${source_branch}" --jq .object.sha
}

require_current_source() {
  local current
  current="$(current_source_ref)"
  [[ "$revision" == "$current" ]] || fail "Source must match current reviewed ${source_branch}"
}

image_metadata() {
  GITHUB_EVENT_NAME=workflow_dispatch GITHUB_REF="$source_ref" \
    node scripts/app-release.mjs image canary "$1" "$version" "$revision"
}

case "$1" in
  promote) python3 scripts/verify-canary-green.py "$receipt" "$3" "$version" ;;
  publish|stage) python3 scripts/verify-canary-green.py "$receipt" "$5" "$version" ;;
esac

scratch="$(mktemp -d)"
cleanup() {
  rm -f -- "$scratch/publisher.json"
  if [[ -d "$scratch/public/storage" || -d "$scratch/publisher/storage" ]]; then
    podman unshare rm -rf -- "$scratch"
  else
    rm -rf -- "$scratch"
  fi
}
trap cleanup EXIT
# Keep registry lookups separate from local tags. Use a clean registry
# configuration to prevent local mirrors and external credential helpers.
mkdir "$scratch/registries.d"
printf 'credential-helpers = ["containers-auth.json"]\n' > "$scratch/registries.conf"
release_podman() {
  CONTAINERS_REGISTRIES_CONF="$scratch/registries.conf" \
    CONTAINERS_REGISTRIES_CONF_DIR="$scratch/registries.d" \
    podman "$@"
}
isolated_podman() {
  local store=$1
  shift
  mkdir -p "$scratch/$store"
  release_podman --root "$scratch/$store/storage" --runroot "$scratch/$store/run" --storage-driver=vfs "$@"
}
repo_digest() {
  local store=$1 image=$2
  isolated_podman "$store" image inspect --format '{{join .RepoDigests "\n"}}' "$image" |
    awk -v repo="${image%:*}" 'index($0, repo "@") == 1 { print substr($0, length(repo) + 2) }'
}

# A separate empty store prevents authenticated or local pulls from hiding access failures.
verify_public_pull() {
  local metadata image platform
  metadata="$(image_metadata "$1")"
  image="$(jq -er .image <<< "$metadata")"
  platform="$(jq -er .platform <<< "$metadata")"
  printf '{"auths":{}}\n' > "$scratch/anonymous.json"
  XDG_CONFIG_HOME="$scratch" DOCKER_CONFIG="$scratch" \
    isolated_podman public pull --tls-verify=true --authfile "$scratch/anonymous.json" --policy always --platform "$platform" "$image"
  [[ "$(repo_digest public "$image")" == "$2" ]] || fail "Unexpected published digest for $image"
  isolated_podman public image inspect "$image" |
    bash scripts/check-app-release-image.sh "$revision" "$1" "$platform" "$version" "$3" ||
    fail "Unexpected image ID or release metadata for $image"
}

check_app_checkout() {
  local destination=$1 app_main
  [[ "$(git -C "$destination" rev-parse --show-toplevel)" == "$destination" ]] || fail 'Expected a separate App repository checkout'
  [[ -z "$(git -C "$destination" status --porcelain)" ]] || fail 'Use a clean App repository checkout'
  app_main="$(gh api --hostname github.com repos/ryan-winkler/meitheal-ha-addon/git/ref/heads/main --jq .object.sha)"
  [[ "$(git -C "$destination" rev-parse HEAD)" == "$app_main" ]] || fail 'App checkout must match current main'
}

write_stage() {
  local destination=$1
  require_current_source
  check_app_checkout "$destination"
  node scripts/app-release.mjs stage canary "$version" "$destination"
  printf 'Version: %s\nSource: %s\namd64: %s (%s)\naarch64: %s (%s)\n' "$version" "$revision" "$2" "$3" "$4" "$5"
}

registry_login() {
  release_podman login --tls-verify=true --authfile "$scratch/publisher.json" --username "$1" --password-stdin ghcr.io
}

# Call only after the exact local candidate has passed smoke and the Green receipt has passed.
# Sets published_digest to the verified registry digest.
publish_image() {
  local arch=$1 qualified_id=$2 metadata image platform image_id existing_id digest
  require_current_source
  metadata="$(image_metadata "$arch")"
  image="$(jq -er .image <<< "$metadata")"
  platform="$(jq -er .platform <<< "$metadata")"
  image_id="${qualified_id#sha256:}"
  if isolated_podman publisher manifest inspect --tls-verify=true --authfile "$scratch/publisher.json" "$image" > /dev/null 2> "$scratch/manifest-error"; then
    existing_id="$(isolated_podman publisher pull --tls-verify=true --quiet --authfile "$scratch/publisher.json" --platform "$platform" "$image")"
    [[ "$existing_id" == "$image_id" ]] || fail 'Published version already points to a different image'
    digest="$(repo_digest publisher "$image")"
  elif grep -Eq ': (manifest|name) unknown$' "$scratch/manifest-error"; then
    require_current_source
    release_podman push --format v2s2 --tls-verify=true --authfile "$scratch/publisher.json" --digestfile "$scratch/digest" "$image_id" "docker://$image" >&2
    digest="$(cat "$scratch/digest")"
  else
    cat "$scratch/manifest-error" >&2
    fail 'Could not confirm the version tag is absent'
  fi

  [[ "$digest" =~ ^sha256:[a-f0-9]{64}$ ]] || fail 'Expected a single published digest'
  verify_public_pull "$arch" "$digest" "$qualified_id" >&2
  published_digest=$digest
}

if [[ "$1" == stage ]]; then
  require_current_source
  for digest_or_id in "$2" "$3" "$4" "$5"; do
    [[ "$digest_or_id" =~ ^sha256:[a-f0-9]{64}$ ]] || fail 'Expected both published digests and qualified image IDs'
  done
  destination="$(realpath -e -- "$6")"
  check_app_checkout "$destination"
  verify_public_pull amd64 "$2" "$3"
  verify_public_pull aarch64 "$4" "$5"
  write_stage "$destination" "$2" "$3" "$4" "$5"
  exit
fi

if [[ "$1" == promote ]]; then
  require_current_source
  [[ "$2" =~ ^sha256:[a-f0-9]{64}$ && "$3" =~ ^sha256:[a-f0-9]{64}$ ]] || fail 'Expected both qualified local image IDs'
  destination="$(realpath -e -- "$5")"
  check_app_checkout "$destination"
  bash scripts/smoke-app-release-image.sh podman "${3#sha256:}" "$revision" aarch64 linux/arm64 "$version" "$3"
  bash scripts/smoke-app-release-image.sh podman "${2#sha256:}" "$revision" amd64 linux/amd64 "$version" "$2"
  require_current_source
  check_app_checkout "$destination"
  registry_login "$4"
  publish_image aarch64 "$3"
  arm_digest=$published_digest
  publish_image amd64 "$2"
  amd_digest=$published_digest
  write_stage "$destination" "$amd_digest" "$2" "$arm_digest" "$3"
  exit
fi

arch=$2
metadata="$(image_metadata "$arch")"
image="$(jq -er .image <<< "$metadata")"
platform="$(jq -er .platform <<< "$metadata")"
local_image="localhost/${image#ghcr.io/}"

if [[ "$1" == build ]]; then
  mkdir "$scratch/source"
  # The rootfs overlay is copied into the image and must be readable by the App user.
  (umask 022; git archive HEAD | tar -x -C "$scratch/source")
  base="$(jq -er .base <<< "$metadata")"
  podman build --format docker --iidfile "$scratch/image-id" --platform "$platform" --file "$scratch/source/meitheal-hub/Dockerfile" \
    --build-arg "BUILD_FROM=$base" --build-arg "MEITHEAL_VERSION=$version" \
    --label "org.opencontainers.image.source=https://github.com/ryan-winkler/meitheal" \
    --label "org.opencontainers.image.revision=$revision" \
    --label "org.opencontainers.image.version=$version" \
    --label "io.hass.version=$version" --label "io.hass.arch=$arch" \
    --tag "$local_image" "$scratch/source"
  image_id="$(cat "$scratch/image-id")"
  image_id="${image_id#sha256:}"
  [[ "$image_id" =~ ^[a-f0-9]{64}$ ]] || fail 'Expected the built image ID'
  bash scripts/smoke-app-release-image.sh podman "$image_id" "$revision" "$arch" "$platform" "$version" "sha256:$image_id"
  printf 'image=%s\nimage_id=sha256:%s\n' "$local_image" "$image_id"
  exit
fi

require_current_source
[[ "$3" =~ ^sha256:[a-f0-9]{64}$ ]] || fail 'Expected the qualified local image ID'
image_id="${3#sha256:}"
if [[ "$arch" == aarch64 ]]; then
  [[ "$3" == "$5" ]] || fail 'ARM64 publication must use the Green-qualified image'
else
  # Bind the Green-qualified sibling image to the same full source revision.
  podman image inspect "${5#sha256:}" |
    bash scripts/check-app-release-image.sh "$revision" aarch64 linux/arm64 "$version" "$5" ||
    fail 'Local Green-qualified ARM64 image does not match the source revision'
fi
bash scripts/smoke-app-release-image.sh podman "$image_id" "$revision" "$arch" "$platform" "$version" "$3"

registry_login "$4"
publish_image "$arch" "$3"
printf 'image=%s\ndigest=%s\n' "$image" "$published_digest"
