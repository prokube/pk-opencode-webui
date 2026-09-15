#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
PROBE="$ROOT/probe-registry-manifest.sh"
WORKFLOW="$ROOT/../workflows/pk-opencode.yml"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

cat > "$TMP/curl" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

accept=""
connect_timeout=""
max_time=""
output=""
request=""

while (( $# > 0 )); do
  case "$1" in
    --connect-timeout)
      connect_timeout="$2"
      shift 2
      ;;
    --max-time)
      max_time="$2"
      shift 2
      ;;
    --output)
      output="$2"
      shift 2
      ;;
    --request)
      request="$2"
      shift 2
      ;;
    --header)
      if [[ "$2" == Accept:* ]]; then
        accept="${2#Accept: }"
      fi
      shift 2
      ;;
    *)
      shift
      ;;
  esac
done

[[ "$connect_timeout" == "10" && "$max_time" == "30" ]] || exit 97
[[ "$request" == "GET" && -n "$output" ]] || exit 97

media_types=(
  "application/vnd.oci.image.manifest.v1+json"
  "application/vnd.oci.image.index.v1+json"
  "application/vnd.docker.distribution.manifest.v2+json"
  "application/vnd.docker.distribution.manifest.list.v2+json"
)
for media_type in "${media_types[@]}"; do
  [[ "$accept" == *"$media_type"* ]] || exit 98
done

printf '%s' "${MOCK_BODY:-}" > "$output"
printf '%s' "${MOCK_STATUS:-000}"
exit "${MOCK_EXIT:-0}"
EOF
chmod +x "$TMP/curl"

expect_result() {
  local expected="$1"
  local status="$2"
  local body="$3"
  local result

  if ! result=$(CURL_BIN="$TMP/curl" MOCK_STATUS="$status" MOCK_BODY="$body" \
    bash "$PROBE" "https://registry.example/manifests/v1.2.3" "token"); then
    echo "Expected $status response to produce $expected" >&2
    exit 1
  fi
  [[ "$result" == "$expected" ]]
}

expect_failure() {
  local status="$1"
  local body="$2"
  local exit_code="${3:-0}"

  if CURL_BIN="$TMP/curl" MOCK_STATUS="$status" MOCK_BODY="$body" MOCK_EXIT="$exit_code" \
    bash "$PROBE" "https://registry.example/manifests/v1.2.3" "token" > /dev/null 2>&1; then
    echo "Expected $status response to fail" >&2
    exit 1
  fi
}

expect_result "present" "200" '{}'
expect_result "missing" "404" '{"errors":[{"code":"MANIFEST_UNKNOWN"}]}'
expect_failure "404" '{"errors":[{"code":"NAME_UNKNOWN"}]}'
expect_failure "404" '{"errors":[{"code":"MANIFEST_UNKNOWN"},{"code":"NAME_UNKNOWN"}]}'
expect_failure "404" '{}'
expect_failure "404" 'not-json'
expect_failure "401" '{"errors":[{"code":"UNAUTHORIZED"}]}'
expect_failure "500" '{}'
expect_failure "000" '' "28"

for file in "$PROBE" "$WORKFLOW"; do
  grep -F -- "--connect-timeout 10" "$file" > /dev/null
  grep -F -- "--max-time 30" "$file" > /dev/null
done
