#!/usr/bin/env bash
set -euo pipefail

if (( $# != 2 )); then
  echo "Usage: $0 <manifest-url> <access-token>" >&2
  exit 2
fi

URL="$1"
TOKEN="$2"
CURL_BIN="${CURL_BIN:-curl}"
BODY=$(mktemp)
trap 'rm -f "$BODY"' EXIT

ACCEPT="application/vnd.oci.image.manifest.v1+json, application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.v2+json, application/vnd.docker.distribution.manifest.list.v2+json"

if ! HTTP_STATUS=$("$CURL_BIN" --silent --show-error --output "$BODY" \
  --connect-timeout 10 \
  --max-time 30 \
  --request GET \
  --write-out "%{http_code}" \
  --header "Authorization: Bearer $TOKEN" \
  --header "Accept: $ACCEPT" \
  "$URL"); then
  echo "Registry manifest request failed" >&2
  exit 1
fi

case "$HTTP_STATUS" in
  200)
    echo "present"
    ;;
  404)
    if jq -e '
      .errors as $errors |
      ($errors | type == "array" and length > 0) and
      ($errors | all(.code == "MANIFEST_UNKNOWN"))
    ' "$BODY" > /dev/null 2>&1; then
      echo "missing"
      exit 0
    fi

    echo "Registry returned an unconfirmed or ambiguous 404" >&2
    exit 1
    ;;
  *)
    echo "Registry returned HTTP $HTTP_STATUS" >&2
    exit 1
    ;;
esac
