#!/usr/bin/env bash
# Docker smoke (Plan v5 T44): builds the image, starts it with the hardening of compose.yaml, no accounts file and an
# empty volume, and checks health, the auth guard, the welcome page, the healthcheck status and the migrations.
# Production mode has no dev login, so there are no login steps in the container (the full flow runs in smoke:e2e).
# Output: `ok|FAIL <step>`, exit code 1 on failure. Never prints mail data (there is none). Not part of CI.
# Environment: IMAGE_DOCKERFILE (default Dockerfile), SMOKE_PORT (default: free port), DOCKER_BUILD_ARGS (extra build args).
set -u
cd "$(dirname "$0")/.."

NAME="email-agent-smoke-$$"
VOLUME="email-agent-smoke-data-$$"
IMAGE="email-agent-smoke:$$"
DOCKERFILE="${IMAGE_DOCKERFILE:-Dockerfile}"
PORT="${SMOKE_PORT:-$(node -e "const s=require('node:net').createServer();s.listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})")}"
FAILED=0
# SMOKE_READ_ONLY=0 drops --read-only (diagnosis only: see README, Smoke-Tests).
RO_FLAG="--read-only"; [ "${SMOKE_READ_ONLY:-1}" = "0" ] && RO_FLAG="--pull=never"

cleanup() {
  [ "${SMOKE_KEEP_LOGS:-0}" = "1" ] && docker logs "$NAME" 2>&1 | grep -o "\"error\":\"[^\"]*\"" | sort -u | head -5
  docker rm -f "$NAME" >/dev/null 2>&1
  docker volume rm "$VOLUME" >/dev/null 2>&1
  docker rmi "$IMAGE" >/dev/null 2>&1
}
trap cleanup EXIT

# shellcheck disable=SC2086
if ! docker build -q -f "$DOCKERFILE" ${DOCKER_BUILD_ARGS:-} -t "$IMAGE" . >/dev/null 2>&1; then
  echo "FAIL build"; exit 1
fi
echo "ok build"

docker volume create "$VOLUME" >/dev/null
# Hardening as in compose.yaml, without the accounts file and with an empty named volume (initialised from the
# image's /data, which belongs to user node). Compose passes OPENROUTER_API_KEY; the smoke needs no model.
if ! docker run -d --name "$NAME" \
  $RO_FLAG --tmpfs /tmp --tmpfs /home/node/.cache \
  --cap-drop ALL --security-opt no-new-privileges:true \
  -e DATABASE_PATH=/data/email-agent.sqlite -e BIND_ADDRESS=0.0.0.0 \
  -v "$VOLUME:/data" \
  -p "127.0.0.1:$PORT:3000" \
  --health-cmd "node -e \"fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))\"" \
  --health-interval 2s --health-timeout 5s --health-retries 3 --health-start-period 5s \
  "$IMAGE" >/dev/null 2>&1; then
  echo "FAIL start"; exit 1
fi
echo "ok start"

code() { curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$1"; }
expect_code() { # expect_code <name> <expected> <url>
  local got
  got="$(code "$3")"
  if [ "$got" = "$2" ]; then echo "ok $1 $got"; else echo "FAIL $1 $got"; FAILED=1; fi
}

# Wait for the server; at most ~90 s.
for _ in $(seq 1 90); do
  [ "$(code "http://127.0.0.1:$PORT/api/health")" = "200" ] && break
  sleep 1
done

expect_code "GET /api/health" 200 "http://127.0.0.1:$PORT/api/health"
expect_code "GET /api/emails without session" 401 "http://127.0.0.1:$PORT/api/emails"
expect_code "GET /welcome" 200 "http://127.0.0.1:$PORT/welcome"

STATUS=""
for _ in $(seq 1 30); do
  STATUS="$(docker inspect -f '{{.State.Health.Status}}' "$NAME" 2>/dev/null)"
  [ "$STATUS" = "healthy" ] && break
  sleep 2
done
if [ "$STATUS" = "healthy" ]; then echo "ok healthcheck healthy"; else echo "FAIL healthcheck ${STATUS:-unknown}"; FAILED=1; fi

# Only a count leaves the container: how many of the migrations 1..6 are recorded in schema_migrations.
MIG="$(docker exec "$NAME" node -e "
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('/data/email-agent.sqlite', { readOnly: true });
console.log(String(db.prepare('SELECT COUNT(*) AS n FROM schema_migrations WHERE version BETWEEN 1 AND 6').get().n));
" 2>/dev/null)"
if [ "$MIG" = "6" ]; then echo "ok migrations 1-6 applied"; else echo "FAIL migrations 1-6 applied (${MIG:-database not readable})"; FAILED=1; fi

exit "$FAILED"
