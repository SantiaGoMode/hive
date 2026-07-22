#!/usr/bin/env bash
set -euo pipefail

artifact_dir="${1:-desktop/dist}"
shopt -s nullglob
packages=("$artifact_dir"/*.deb)
if (( ${#packages[@]} != 1 )); then
  echo "Expected exactly one Debian package in $artifact_dir; found ${#packages[@]}" >&2
  exit 1
fi
package_path=$(readlink -f "${packages[0]}")

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y xvfb curl "$package_path"

export HIVE_DESKTOP_PORT="${HIVE_DESKTOP_PORT:-45671}"
export HIVE_HOME="${HIVE_HOME:-/tmp/hive-installed-smoke}"
mkdir -p "$HIVE_HOME"

log_file=/tmp/hive-installed-smoke.log
xvfb-run -a hive --no-sandbox >"$log_file" 2>&1 &
hive_pid=$!
cleanup() {
  kill "$hive_pid" 2>/dev/null || true
  wait "$hive_pid" 2>/dev/null || true
}
trap cleanup EXIT

for _ in $(seq 1 60); do
  if curl --fail --silent --show-error "http://127.0.0.1:${HIVE_DESKTOP_PORT}/readyz" >/dev/null; then
    status=$(curl --silent --output /dev/null --write-out '%{http_code}' "http://127.0.0.1:${HIVE_DESKTOP_PORT}/api/agents")
    if [[ "$status" != "401" ]]; then
      echo "Expected protected API to return 401 without the desktop token; got $status" >&2
      exit 1
    fi
    echo "Installed Hive package passed readiness and authentication smoke checks"
    exit 0
  fi
  if ! kill -0 "$hive_pid" 2>/dev/null; then
    echo "Installed Hive process exited before readiness" >&2
    sed -n '1,240p' "$log_file" >&2
    exit 1
  fi
  sleep 1
done

echo "Installed Hive package did not become ready" >&2
sed -n '1,240p' "$log_file" >&2
exit 1
