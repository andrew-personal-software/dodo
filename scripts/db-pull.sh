#!/usr/bin/env bash
# Replaces the local dev schema and files with a fresh snapshot of prod: pnpm db:pull
# Prod is never written. Needs the dev Postgres from `pnpm dev` (container dodo-dev-pg). Stop `pnpm dev` first.
set -euo pipefail

HOST=${DODO_HOST:-root@andrewsserver}
FILES=${DODO_FILES:-$HOME/.dodo/files}
RT=$(command -v podman || command -v docker) || { echo "error: no podman or docker" >&2; exit 1; }

dump=$(mktemp)
trap 'rm -f "$dump"' EXIT
ssh "$HOST" 'podman exec postgres pg_dump -Fc -U postgres -d apps -n dodo' >"$dump"
[[ -s $dump ]] || { echo "error: empty dump" >&2; exit 1; }

"$RT" exec dodo-dev-pg psql -q -U postgres -c 'CREATE EXTENSION IF NOT EXISTS pg_trgm' -c 'DROP SCHEMA IF EXISTS dodo CASCADE'
"$RT" exec -i dodo-dev-pg pg_restore -U postgres -d postgres --no-owner --no-privileges -n dodo <"$dump"
count=$("$RT" exec dodo-dev-pg psql -U postgres -tAc 'SELECT count(*) FROM dodo.docs WHERE deleted_at IS NULL')

mkdir -p "$FILES"
rsync -a --delete "$HOST:/var/lib/dodo/files/" "$FILES/"
echo "pulled $count docs into schema dodo"
