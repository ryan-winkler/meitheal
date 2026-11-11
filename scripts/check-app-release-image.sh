#!/usr/bin/env bash
set -euo pipefail

jq -e --arg revision "$1" --arg arch "$2" --arg platform "$3" --arg version "$4" --arg id "${5:-}" '
  .[0] |
  (.Os + "/" + .Architecture) == $platform and
  .Config.Labels["org.opencontainers.image.revision"] == $revision and
  .Config.Labels["org.opencontainers.image.licenses"] == "LicenseRef-Proprietary" and
  .Config.Labels["io.hass.version"] == $version and
  .Config.Labels["io.hass.arch"] == $arch and
  .Config.Labels["io.hass.type"] == "addon" and
  ($id == "" or ("sha256:" + (.Id | sub("^sha256:"; ""))) == $id)
' > /dev/null
