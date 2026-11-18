#!/usr/bin/env bash
# Runs `next dev` on the first free port from 3000: pnpm dev [--env dev|prod] [next dev options]
# --env dev (the default) uses the local DB. --env prod sends the app's API calls to the prod server.
# Writes ~/.dodo/dev.json with the url and env, for the toggle in the app and `dodo --env dev`.
# Starts the dev Postgres (container dodo-dev-pg on 127.0.0.1:55432, podman or docker) and migrates schema dodo.
set -euo pipefail

ENV=dev
PORT=
args=()
while (($#)); do
  case $1 in
    --env) ENV=${2:-}; shift 2 || shift ;;
    --env=*) ENV=${1#*=}; shift ;;
    -p | --port) PORT=${2:-}; shift 2 || shift ;;
    *) args+=("$1"); shift ;;
  esac
done
[[ $ENV == dev || $ENV == prod ]] || { echo "error: --env must be dev or prod" >&2; exit 1; }

if [[ -z $PORT ]]; then
  PORT=3000
  while lsof -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; do PORT=$((PORT + 1)); done
fi

# The dev DB. Tests use the same server (a fresh schema per test).
RT=$(command -v podman || command -v docker || true)
[[ -n $RT ]] || { echo "error: install podman (brew install podman && podman machine init --now) or docker" >&2; exit 1; }
if [[ -z $("$RT" ps -q --filter name=^dodo-dev-pg$) ]]; then
  "$RT" start dodo-dev-pg >/dev/null 2>&1 ||
    "$RT" run -d --name dodo-dev-pg -p 127.0.0.1:55432:5432 -e POSTGRES_PASSWORD=dev docker.io/library/postgres:17 >/dev/null
fi
for _ in $(seq 1 30); do "$RT" exec dodo-dev-pg pg_isready -q -U postgres && break; sleep 1; done
"$RT" exec dodo-dev-pg psql -q -U postgres -c 'CREATE EXTENSION IF NOT EXISTS pg_trgm' -c 'CREATE SCHEMA IF NOT EXISTS dodo'
pnpm exec tsup --silent
node dist/migrate.js

STATE=$HOME/.dodo/dev.json
mkdir -p "$(dirname "$STATE")"
running=$(grep -o '"pid":[0-9]*' "$STATE" 2>/dev/null | cut -d: -f2 || true)
if [[ -n $running ]] && kill -0 "$running" 2>/dev/null; then
  echo "error: a dodo dev server is already running (pid $running, see $STATE)" >&2
  exit 1
fi
echo "{\"url\":\"http://localhost:$PORT\",\"env\":\"$ENV\",\"pid\":$$}" >"$STATE"
trap 'grep -qF "\"pid\":$$}" "$STATE" 2>/dev/null && rm -f "$STATE"' EXIT

next dev -p "$PORT" ${args[@]+"${args[@]}"}
