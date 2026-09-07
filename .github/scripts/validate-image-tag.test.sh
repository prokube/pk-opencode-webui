#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
VALIDATOR=(bash "$ROOT/validate-image-tag.sh")

expect_valid() {
  if ! "${VALIDATOR[@]}" "$1" "$2" > /dev/null; then
    echo "Expected valid $2 tag: $1" >&2
    exit 1
  fi
}

expect_invalid() {
  if "${VALIDATOR[@]}" "$1" "$2" > /dev/null 2>&1; then
    echo "Expected invalid $2 tag: $1" >&2
    exit 1
  fi
}

release_128="v$(printf '1%.0s' {1..123}).1.1"
release_129="v$(printf '1%.0s' {1..124}).1.1"
development_128="a$(printf 'x%.0s' {1..127})"
development_129="a$(printf 'x%.0s' {1..128})"

expect_valid "v0.0.0" release
expect_valid "v12.34.56-rc7" release
expect_valid "$release_128" release
expect_invalid "v1.2" release
expect_invalid "v1.2.3-rc" release
expect_invalid "v1.2.3-alpha1" release
expect_invalid "$release_129" release

expect_valid "v1.2.3-a1b2c3d" development
expect_valid "release_candidate-1.2" development
expect_valid "$development_128" development
expect_invalid "invalid/tag-a1b2c3d" development
expect_invalid "-invalid" development
expect_invalid "$development_129" development
expect_invalid "valid-tag" unknown
