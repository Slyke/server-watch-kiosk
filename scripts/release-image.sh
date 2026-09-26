#!/usr/bin/env bash
set -euo pipefail
# Explicit operator workflow; this script is never run by the app.
: "${IMAGE:?Set IMAGE to your registry/repository name}"
test -z "$(git status --porcelain)" || { echo "Release requires a clean working tree" >&2; exit 1; }
version="$(node -p "require('./package.json').version")"
sha="$(git rev-parse --short=12 HEAD)"
docker build --build-arg BUILD_HASH="$sha" -t "$IMAGE:$version-$sha" .
docker tag "$IMAGE:$version-$sha" "$IMAGE:$version"
docker tag "$IMAGE:$version-$sha" "$IMAGE:latest"
if [[ "${PUBLISH:-false}" == true ]]; then
  docker push "$IMAGE:$version-$sha"
  docker push "$IMAGE:$version"
  docker push "$IMAGE:latest"
fi
