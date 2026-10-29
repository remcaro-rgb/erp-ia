#!/usr/bin/env sh
# Copies the images in docker/images.txt to ghcr.io/<owner>/erp-ia/<name>:<tag> from a developer machine (the
# mirror-images workflow does the same from a runner, whose shared IP the public registries throttle). Needs
# `docker login ghcr.io` with a token that has write:packages (`gh auth refresh -s write:packages`, then
# `gh auth token | docker login ghcr.io -u <user> --password-stdin`). Usage: docker/mirror-images.sh [owner]
set -eu
owner="${1:-$(gh api user --jq .login)}"
prefix="ghcr.io/$(printf '%s' "$owner" | tr '[:upper:]' '[:lower:]')/erp-ia"
dir="$(cd "$(dirname "$0")" && pwd)"
count=0
while read -r source name extra; do
  case "${source}" in ''|\#*) continue ;; esac
  [ -n "${name:-}" ] && [ -z "${extra:-}" ] || { echo "docker/images.txt: expected '<source image> <mirror name>', got: ${source} ${name:-} ${extra:-}" >&2; exit 1; }
  tag="${source##*:}"
  target="${prefix}/${name}:${tag}"
  echo "== ${source} -> ${target}"
  docker buildx imagetools create --tag "${target}" "${source}"
  docker buildx imagetools inspect "${target}" >/dev/null
  count=$((count + 1))
done < "${dir}/images.txt"
echo "Mirrored ${count} images to ${prefix}"
