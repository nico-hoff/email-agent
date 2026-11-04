#!/bin/sh
# Container entrypoint. As node (Compose, hardened): runs the command as is.
# As root (fly.io: a fresh volume is mounted root-owned, and the app requires its data directory to be 0700 and
# its own): fixes the data directory, then permanently drops to user node. Never prints paths' contents or secrets.
set -eu

# Opt-in (fly.toml, ADR 0046): Tailscale in userspace mode as user node, state on the volume, HTTPS via `tailscale serve`
# to the app. The auth key (TS_AUTHKEY) is only needed until the node is registered; it is never printed and is removed
# from the environment before the app starts.
start_tailscale() {
  as_node="$1"
  state="$(dirname "${DATABASE_PATH:-/data/email-agent.sqlite}")/tailscale"
  sock="$state/tailscaled.sock"
  run() { if [ "$as_node" = "1" ]; then setpriv --reuid=node --regid=node --init-groups -- "$@"; else "$@"; fi; }
  run mkdir -p "$state"
  chmod 700 "$state" 2>/dev/null || true
  run tailscaled --tun=userspace-networking --statedir="$state" --socket="$sock" >/dev/null 2>&1 &
  i=0
  while [ ! -S "$sock" ] && [ "$i" -lt 50 ]; do sleep 0.2; i=$((i + 1)); done
  if [ ! -S "$sock" ]; then echo "entrypoint: tailscaled did not start" >&2; exit 1; fi
  running() { run tailscale --socket="$sock" status --json 2>/dev/null | grep -q '"BackendState": *"Running"'; }
  # Saved state: tailscaled reconnects on its own; give it up to 10 s.
  i=0
  while ! running && [ "$i" -lt 50 ]; do sleep 0.2; i=$((i + 1)); done
  if running; then
    echo "entrypoint: tailscale connected (saved state)"
  elif [ -n "${TS_AUTHKEY:-}" ]; then
    # The key goes through a private file, not argv (ps), and is deleted right after use.
    keyfile="$state/.authkey"
    umask 077
    printf '%s' "$TS_AUTHKEY" > "$keyfile"
    chown node:node "$keyfile" 2>/dev/null || true
    run tailscale --socket="$sock" up --auth-key="file:$keyfile" --hostname="${TS_HOSTNAME:-email-agent}" >/dev/null 2>&1 || { rm -f "$keyfile"; echo "entrypoint: tailscale up failed" >&2; exit 1; }
    rm -f "$keyfile"
    echo "entrypoint: tailscale registered"
  else
    echo "entrypoint: TAILSCALE_ENABLE=1 but no TS_AUTHKEY and no saved tailscale state" >&2
    exit 1
  fi
  run tailscale --socket="$sock" serve --bg --https=443 "http://127.0.0.1:${PORT:-3000}" >/dev/null
  echo "entrypoint: tailscale serve https -> 127.0.0.1:${PORT:-3000}"
  unset TS_AUTHKEY
}

if [ "$(id -u)" = "0" ]; then
  dir="$(dirname "${DATABASE_PATH:-/data/email-agent.sqlite}")"
  case "$dir" in
    /|/proc|/sys|/dev|/etc|/usr|/bin|/sbin|/lib|/app) echo "entrypoint: refusing to change ownership of $dir" >&2; exit 1 ;;
  esac
  mkdir -p "$dir"
  chown -R node:node "$dir"
  chmod 700 "$dir"
  # A secret file written by fly ([[files]]) arrives root-owned; the app demands 0600 and must be able to read it.
  if [ -n "${ACCOUNTS_FILE:-}" ] && [ -f "$ACCOUNTS_FILE" ] && [ ! -L "$ACCOUNTS_FILE" ]; then
    chown node:node "$ACCOUNTS_FILE"
    chmod 600 "$ACCOUNTS_FILE"
  fi
  export HOME=/home/node
  if [ "${TAILSCALE_ENABLE:-}" = "1" ]; then start_tailscale 1; fi
  # Opt-in (fly.preview.toml only): fill an empty preview database with the built-in synthetic set, as user node.
  if [ "${PREVIEW_SEED_SYNTHETIC:-}" = "1" ]; then
    setpriv --reuid=node --regid=node --init-groups -- node /app/scripts/seed-preview.ts
  fi
  exec setpriv --reuid=node --regid=node --init-groups -- "$@"
fi

if [ "${TAILSCALE_ENABLE:-}" = "1" ]; then start_tailscale 0; fi

if [ "${PREVIEW_SEED_SYNTHETIC:-}" = "1" ]; then
  node /app/scripts/seed-preview.ts
fi

exec "$@"
