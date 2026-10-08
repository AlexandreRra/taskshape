#!/bin/sh
# Bootstrap Node for Taskshape hooks without touching global PATH or package managers.
set -u

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
plugin_root=$(CDPATH= cd -- "$script_dir/.." && pwd -P)
script=${1:-}
if [ "$#" -gt 0 ]; then shift; fi

home_dir=${TASKSHAPE_HOME:-${HOME:-}/.taskshape}
node_root="$home_dir/node"
assets=${TASKSHAPE_NODE_ASSETS:-$plugin_root/runtime/node-assets.tsv}
status_file="$node_root/status.txt"

platform() {
  os=$(uname -s 2>/dev/null || echo unknown)
  arch=$(uname -m 2>/dev/null || echo unknown)
  case "$os:$arch" in
    Linux:x86_64|Linux:amd64) echo linux-x64 ;;
    Linux:aarch64|Linux:arm64) echo linux-arm64 ;;
    Darwin:x86_64|Darwin:amd64) echo darwin-x64 ;;
    Darwin:arm64|Darwin:aarch64) echo darwin-arm64 ;;
    *) echo unsupported ;;
  esac
}

valid_node() {
  "$1" -e 'const [M,m]=process.versions.node.split(".").map(Number); process.exit(M>22||(M===22&&m>=6)?0:1)' >/dev/null 2>&1
}

system_node() {
  if [ "${TASKSHAPE_FORCE_BUNDLED_NODE:-}" = 1 ]; then return 1; fi
  n=$(command -v node 2>/dev/null || true)
  if [ -n "$n" ] && valid_node "$n"; then printf '%s\n' "$n"; return 0; fi
  return 1
}

asset_field() {
  awk -F '\t' -v p="$1" -v n="$2" 'NF >= 4 && $1 == p { print $n; exit }' "$assets" 2>/dev/null
}

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'; return 0; fi
  if command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | awk '{print $1}'; return 0; fi
  if command -v openssl >/dev/null 2>&1; then openssl dgst -sha256 "$1" | awk '{print $NF}'; return 0; fi
  return 1
}

download() {
  url=$1
  out=$2
  if command -v curl >/dev/null 2>&1; then curl -fsSL --retry 2 --connect-timeout 20 --max-time 1800 -o "$out" "$url"; return $?; fi
  if command -v wget >/dev/null 2>&1; then wget -q -O "$out" "$url"; return $?; fi
  return 1
}

write_status() {
  mkdir -p "$node_root" 2>/dev/null || true
  printf '%s\n' "$1" > "$status_file" 2>/dev/null || true
}

fail_install() {
  write_status "error: $1"
  exit 0
}

prepare_laya() {
  node_bin=$1
  cli="$script_dir/runtime-cli.ts"
  if [ -f "$cli" ]; then
    "$node_bin" --no-warnings --experimental-strip-types "$cli" prepare >/dev/null 2>&1 &
  fi
}

stale_lock() {
  lock=$1
  pid_file="$lock/pid"
  if [ -f "$pid_file" ]; then
    pid=$(cat "$pid_file" 2>/dev/null || true)
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then return 1; fi
    return 0
  fi
  if command -v find >/dev/null 2>&1 && [ -n "$(find "$lock" -maxdepth 0 -mmin +30 -print 2>/dev/null)" ]; then return 0; fi
  return 1
}

install_node() {
  plat=$(platform)
  [ "$plat" != unsupported ] || fail_install "Node.js is not packaged for this platform"
  version=$(asset_field "$plat" 2)
  filename=$(asset_field "$plat" 3)
  expected=$(asset_field "$plat" 4)
  [ -n "$version" ] && [ -n "$filename" ] && [ -n "$expected" ] || fail_install "missing Node.js asset pin for $plat"
  dest="$node_root/v$version/$plat"
  bin="$dest/bin/node"
  [ -x "$bin" ] && valid_node "$bin" && { write_status ready; prepare_laya "$bin"; exit 0; }
  lock="$node_root/install.lock"
  mkdir -p "$node_root" 2>/dev/null || exit 0
  if ! mkdir "$lock" 2>/dev/null; then
    if stale_lock "$lock"; then rm -rf "$lock" 2>/dev/null || true; else exit 0; fi
    mkdir "$lock" 2>/dev/null || exit 0
  fi
  printf '%s\n' "$$" > "$lock/pid" 2>/dev/null || true
  tmp="$node_root/download.$$"
  dest_tmp="$dest.tmp.$$"
  cleanup() { rm -rf "$tmp" "$dest_tmp" "$lock" 2>/dev/null || true; }
  trap cleanup EXIT HUP INT TERM
  write_status installing
  mkdir -p "$tmp" || fail_install "could not create Node.js cache"
  archive="$tmp/$filename"
  if [ -n "${TASKSHAPE_NODE_BASE_URL:-}" ]; then
    case "$TASKSHAPE_NODE_BASE_URL" in https://nodejs.org/*|file://*) url="${TASKSHAPE_NODE_BASE_URL%/}/$filename" ;; *) fail_install "untrusted Node.js download URL" ;; esac
  else
    url="https://nodejs.org/dist/v$version/$filename"
  fi
  download "$url" "$archive" || fail_install "could not download Node.js"
  actual=$(sha256_file "$archive" || true)
  [ "$actual" = "$expected" ] || fail_install "Node.js checksum mismatch"
  mkdir -p "$dest_tmp" || fail_install "could not create Node.js extract folder"
  tar -xf "$archive" -C "$dest_tmp" --strip-components=1 >/dev/null 2>&1 || fail_install "could not extract Node.js"
  [ -x "$dest_tmp/bin/node" ] && valid_node "$dest_tmp/bin/node" || fail_install "downloaded Node.js did not run"
  rm -rf "$dest" 2>/dev/null || true
  mv "$dest_tmp" "$dest" || fail_install "could not activate Node.js"
  write_status ready
  prepare_laya "$bin"
}

bundled_node() {
  plat=$(platform)
  [ "$plat" != unsupported ] || return 1
  version=$(asset_field "$plat" 2)
  [ -n "$version" ] || return 1
  bin="$node_root/v$version/$plat/bin/node"
  if [ -x "$bin" ] && valid_node "$bin"; then printf '%s\n' "$bin"; return 0; fi
  return 1
}

if [ "$script" = "--install-node" ]; then install_node; exit 0; fi

node_bin=$(system_node || true)
if [ -z "$node_bin" ]; then node_bin=$(bundled_node || true); fi
if [ -n "$node_bin" ]; then
  if [ -z "$script" ]; then exit 0; fi
  exec "$node_bin" --no-warnings --experimental-strip-types "$script_dir/$script" "$@"
fi

if [ -f "$status_file" ] && grep -q '^error:' "$status_file" 2>/dev/null; then
  msg=$(sed 's/^error: //' "$status_file" 2>/dev/null | head -1)
  echo "Taskshape: private Node.js setup failed: $msg; original model kept" >&2
else
  echo "Taskshape: preparing private Node.js runtime; original model kept" >&2
fi
nohup sh "$0" --install-node >/dev/null 2>&1 &
exit 0
