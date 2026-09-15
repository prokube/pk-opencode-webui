#!/usr/bin/env bash
set -euo pipefail

TAG="${1:-}"
KIND="${2:-}"

if (( ${#TAG} > 128 )); then
  echo "Docker tag must not exceed 128 characters" >&2
  exit 1
fi

case "$KIND" in
  release)
    if [[ ! "$TAG" =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-rc[0-9]+)?$ ]]; then
      echo "Release tag must match vX.Y.Z or vX.Y.Z-rcN" >&2
      exit 1
    fi
    ;;
  development)
    if [[ ! "$TAG" =~ ^[A-Za-z0-9_][A-Za-z0-9_.-]*$ ]]; then
      echo "Development version is not a valid Docker tag" >&2
      exit 1
    fi
    ;;
  *)
    echo "Tag kind must be release or development" >&2
    exit 1
    ;;
esac
