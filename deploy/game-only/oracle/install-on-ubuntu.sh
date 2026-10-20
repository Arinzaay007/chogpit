#!/usr/bin/env bash
# Run ONLY on your own Oracle Ampere A1 Ubuntu 24.04 arm64 VM after inspecting
# the game-only ZIP. This configures a single game server and HTTPS proxy;
# it does not create any OCI resources or turn on CHOG payouts.
set -Eeuo pipefail

fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
[[ "$(id -u)" == 0 ]] || fail 'Run this script with sudo on the VM.'
# shellcheck disable=SC1091
. /etc/os-release
[[ "${ID:-}" == ubuntu && "${VERSION_ID:-}" == 24.04 && "$(uname -m)" == aarch64 ]] ||
  fail 'Expected Ubuntu 24.04 arm64 on an Oracle Always Free-eligible Ampere A1 VM.'
SRC="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
[[ "$(cat "$SRC/.node-version" 2>/dev/null)" == 22.22.0 ]] || fail 'Wrong game-only Node version.'
[[ -f "$SRC/server.mjs" && -f "$SRC/package-lock.json" && -f "$SRC/oracle/Caddyfile" ]] ||
  fail 'The complete game-only ZIP was not unpacked.'
for forbidden in node_modules data contracts claim-ledger.mjs reward-preview.mjs; do
  [[ ! -e "$SRC/$forbidden" ]] || fail "Unexpected $forbidden in the upload. Use the verified game-only ZIP, not a project or local testing folder."
done

NODE_VERSION=22.22.0
NODE_DIR="/opt/node-v${NODE_VERSION}"
NODE_ARCHIVE="node-v${NODE_VERSION}-linux-arm64.tar.xz"
NODE_SHA256='1bf1eb9ee63ffc4e5d324c0b9b62cf4a289f44332dfef9607cea1a0d9596ba6f'
APP_DIR=/opt/chogpit
DATA_DIR=/var/lib/chogpit
TMP="$(mktemp -d)"
trap 'rm -rf -- "$TMP"' EXIT

printf '%s\n' 'Installing base packages...'
apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
  ca-certificates curl xz-utils gnupg debian-keyring debian-archive-keyring apt-transport-https
if [[ ! -x "$NODE_DIR/bin/node" ]]; then
  [[ ! -e "$NODE_DIR" ]] || fail "Incomplete $NODE_DIR exists; inspect it before retrying."
  curl --fail --show-error --silent --location --retry 3 \
    "https://nodejs.org/dist/v${NODE_VERSION}/${NODE_ARCHIVE}" -o "$TMP/$NODE_ARCHIVE"
  (cd "$TMP" && printf '%s  %s\n' "$NODE_SHA256" "$NODE_ARCHIVE" | sha256sum --check --status) ||
    fail 'The downloaded Node.js archive did not match the pinned official SHA-256.'
  install -d -m 0755 "$NODE_DIR"
  tar -xJf "$TMP/$NODE_ARCHIVE" -C "$NODE_DIR" --strip-components=1 --no-same-owner
fi
[[ "$("$NODE_DIR/bin/node" --version)" == "v${NODE_VERSION}" ]] || fail 'Wrong Node.js version installed.'

if ! id chogpit >/dev/null 2>&1; then
  useradd --system --home-dir "$DATA_DIR" --shell /usr/sbin/nologin chogpit
fi
install -d -o chogpit -g chogpit -m 0750 "$DATA_DIR" "$APP_DIR" \
  "$APP_DIR/public" "$APP_DIR/public/assets" "$APP_DIR/scripts"
for file in server.mjs live-rooms.mjs package.json package-lock.json \
  public/index.html public/app.js public/arena-world.js public/audio.js \
  public/game.js public/style.css public/assets/chog1.jpg \
  public/assets/chogbadge.jpg scripts/smoke.mjs; do
  [[ -f "$SRC/$file" && ! -L "$SRC/$file" ]] || fail "Missing or unsafe game file: $file"
  install -o chogpit -g chogpit -m 0640 "$SRC/$file" "$APP_DIR/$file"
done
(cd "$APP_DIR" && runuser -u chogpit -- env HOME="$DATA_DIR" \
  PATH="$NODE_DIR/bin:/usr/bin:/bin" "$NODE_DIR/bin/npm" ci --omit=dev \
  --ignore-scripts --no-audit --no-fund)

install -o root -g root -m 0644 "$SRC/oracle/chogpit.service" /etc/systemd/system/chogpit.service
systemctl daemon-reload
systemctl enable chogpit.service
systemctl restart chogpit.service
curl --fail --show-error --silent --retry 6 --retry-connrefused --retry-delay 1 \
  --max-time 5 http://127.0.0.1:4173/healthz
printf '\n'
(cd "$APP_DIR" && runuser -u chogpit -- env HOME="$DATA_DIR" \
  PATH="$NODE_DIR/bin:/usr/bin:/bin" "$NODE_DIR/bin/npm" run smoke -- http://127.0.0.1:4173)

printf '%s\n' 'Installing Caddy from its signed Ubuntu package repository...'
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o "$TMP/caddy.gpg"
install -o root -g root -m 0644 "$TMP/caddy.gpg" /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
  -o /etc/apt/sources.list.d/caddy-stable.list
chmod 0644 /etc/apt/sources.list.d/caddy-stable.list
apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends caddy
install -o root -g root -m 0644 "$SRC/oracle/Caddyfile" /etc/caddy/Caddyfile
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
systemctl enable caddy
systemctl restart caddy

printf '\n%s\n' 'Local game smoke passed. Next: allow TCP 80/443 in OCI, point the chogpit.tech root A record at its authoritative DNS provider to this VM public IPv4, then test https://chogpit.tech/healthz and run the smoke test over HTTPS.'
printf '%s\n' 'No public uptime or certificate has been verified by this script. Check: sudo journalctl -u chogpit -u caddy -n 80 --no-pager'
