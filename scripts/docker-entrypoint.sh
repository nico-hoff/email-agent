#!/bin/sh
# Container entrypoint. As node (Compose, hardened): runs the command as is.
# As root (fly.io: a fresh volume is mounted root-owned, and the app requires its data directory to be 0700 and
# its own): fixes the data directory, then permanently drops to user node. Never prints paths' contents or secrets.
set -eu

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
  exec setpriv --reuid=node --regid=node --init-groups -- "$@"
fi

exec "$@"
