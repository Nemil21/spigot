#!/usr/bin/env bash
# One shared local Postgres for every Spigot worktree (SP-001a). Never start your own.
#
#   npm run dev:db            # or: bash scripts/dev-db.sh
#
# - Starts the `spigot-dev-pg` container (postgres:16-alpine on 127.0.0.1:54329) only if it is
#   absent, or `docker start`s it if it exists but is stopped. It is labelled `ao.spare=true`,
#   so AO never reaps it when one worker's session ends.
# - Creates `spigot_<worktree>` (dev) and `spigot_<worktree>_test` (for *.db.test.ts) if missing.
# - Prints the DATABASE_URL / TEST_DATABASE_URL lines for your `.env`.
#
# Safe to run any number of times, from any number of worktrees, at the same time.
# Override the worktree part of the name with SPIGOT_DB_WORKTREE=<name> (and, for testing this
# script only, the container / port with SPIGOT_DB_CONTAINER / SPIGOT_DB_PORT).
# Stop it when nobody needs it: docker stop spigot-dev-pg
set -euo pipefail

CONTAINER="${SPIGOT_DB_CONTAINER:-spigot-dev-pg}"
IMAGE=postgres:16-alpine
PORT="${SPIGOT_DB_PORT:-54329}"
USER_PASS=spigot

worktree="${SPIGOT_DB_WORKTREE:-$(basename "$(git rev-parse --show-toplevel)")}"
# Postgres identifiers: lowercase letters, digits and underscores.
slug="$(printf '%s' "$worktree" | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9' '_' | sed 's/_*$//')"
db="spigot_${slug}"

state=absent
if status="$(docker inspect -f '{{.State.Status}}' "$CONTAINER" 2>/dev/null)"; then state="$status"; fi
case "$state" in
  running) ;;
  absent)
    echo "Starting shared Postgres container $CONTAINER on 127.0.0.1:$PORT" >&2
    # Another worktree may win the race to create it; that's fine, use theirs.
    docker run -d --name "$CONTAINER" \
      --label "ao.session=${AO_SESSION_ID:-manual}" --label ao.spare=true \
      -e POSTGRES_USER="$USER_PASS" -e POSTGRES_PASSWORD="$USER_PASS" -e POSTGRES_DB=postgres \
      -p "127.0.0.1:${PORT}:5432" "$IMAGE" >/dev/null 2>&1 || {
      for _ in $(seq 1 20); do docker inspect "$CONTAINER" >/dev/null 2>&1 && break; sleep 0.5; done
      docker inspect "$CONTAINER" >/dev/null || { echo "Could not start $CONTAINER" >&2; exit 1; }
    }
    ;;
  *)
    echo "Starting stopped container $CONTAINER" >&2
    docker start "$CONTAINER" >/dev/null 2>&1 || true
    ;;
esac

host_port="$(docker port "$CONTAINER" 5432/tcp | head -n1 | sed 's/.*://')"

for _ in $(seq 1 60); do
  # The image's init runs a temporary server on a socket only; wait for TCP to be sure.
  if docker exec "$CONTAINER" pg_isready -q -h 127.0.0.1 -U "$USER_PASS" 2>/dev/null; then break; fi
  sleep 0.5
done
docker exec "$CONTAINER" pg_isready -q -h 127.0.0.1 -U "$USER_PASS" ||
  { echo "Postgres in $CONTAINER did not become ready" >&2; exit 1; }

psql_c() { docker exec "$CONTAINER" psql -h 127.0.0.1 -U "$USER_PASS" -d postgres -tAc "$1"; }

for name in "$db" "${db}_test"; do
  if [ "$(psql_c "select 1 from pg_database where datname = '$name'")" != "1" ]; then
    # Ignore a lost race with a concurrent run creating the same database.
    if docker exec "$CONTAINER" createdb -h 127.0.0.1 -U "$USER_PASS" "$name" 2>/dev/null; then
      echo "Created database $name" >&2
    fi
  fi
  [ "$(psql_c "select 1 from pg_database where datname = '$name'")" = "1" ] ||
    { echo "Could not create database $name" >&2; exit 1; }
done

echo "# Shared dev Postgres ($CONTAINER). Put these in .env:"
echo "DATABASE_URL=postgres://${USER_PASS}:${USER_PASS}@127.0.0.1:${host_port}/${db}"
echo "TEST_DATABASE_URL=postgres://${USER_PASS}:${USER_PASS}@127.0.0.1:${host_port}/${db}_test"
