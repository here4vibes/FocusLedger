#!/bin/bash
# SessionStart hook for Claude Code cloud sessions (wired in .claude/settings.json).
#
# Gets a fresh container ready to test: npm deps, local Postgres, the fl/fl role,
# the focusledger database, migrations, and the session env vars.
#
# Rules: idempotent, quick when already set up, never fails the session (every
# step logs and carries on; the script always exits 0). Runs only in cloud
# sessions unless FL_SESSION_SETUP=force.
set -uo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ] && [ "${FL_SESSION_SETUP:-}" != "force" ]; then
  exit 0
fi

ROOT="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "$0")/../.." && pwd)}"
cd "$ROOT" || { echo "[session-start] cannot cd to $ROOT"; exit 0; }

LOCAL_DB_URL="postgres://fl:fl@localhost:5432/focusledger"
LOG_DIR="${TMPDIR:-/tmp}/fl-session-start"
mkdir -p "$LOG_DIR" 2>/dev/null || LOG_DIR="/tmp"

log() { echo "[session-start] $*"; }

# ---------------------------------------------------------------------------
# 1. npm dependencies
# ---------------------------------------------------------------------------
# `npm ci` fails in cloud sessions on apn's GitHub tarball (its http2 dep).
# Fallback: drop apn from package.json, `npm install`, then restore both
# manifests byte-for-byte. Once apn leaves package.json, `npm ci` just works.
BAK=""
# Put the committed manifests back (on return from install_deps, and on exit/kill).
restore_manifests() {
  [ -n "$BAK" ] || return 0
  cp "$BAK/package.json" "$BAK/package-lock.json" "$ROOT/" 2>/dev/null \
    || log "deps: RESTORE FAILED, restore package.json and package-lock.json from git"
  rm -rf "$BAK"
  BAK=""
}
trap restore_manifests EXIT INT TERM

lock_hash() { cat package.json package-lock.json 2>/dev/null | sha256sum | cut -d' ' -f1; }
STAMP="node_modules/.fl-session-deps"

install_deps() {
  local want; want="$(lock_hash)"
  if [ -d node_modules ] && [ -f "$STAMP" ] && [ "$(cat "$STAMP")" = "$want" ]; then
    log "deps: up to date"
    return 0
  fi

  log "deps: trying npm ci"
  if npm ci --no-audit --no-fund >"$LOG_DIR/npm-ci.log" 2>&1; then
    echo "$want" >"$STAMP"
    log "deps: npm ci ok"
    return 0
  fi
  log "deps: npm ci failed (see $LOG_DIR/npm-ci.log); falling back to npm install without apn"

  BAK="$(mktemp -d)"
  cp package.json package-lock.json "$BAK/" || { log "deps: backup failed, skipping install"; rm -rf "$BAK"; BAK=""; return 0; }

  if grep -q '"apn"' package.json; then
    node -e '
      const fs = require("fs");
      const p = JSON.parse(fs.readFileSync("package.json", "utf8"));
      for (const k of ["dependencies", "devDependencies", "optionalDependencies"]) {
        if (p[k]) delete p[k].apn;
      }
      fs.writeFileSync("package.json", JSON.stringify(p, null, 2) + "\n");
    ' || log "deps: could not strip apn"
  fi

  local ok=0
  npm install --no-audit --no-fund >"$LOG_DIR/npm-install.log" 2>&1 && ok=1
  restore_manifests
  if [ "$ok" = "1" ]; then
    lock_hash >"$STAMP"   # hash of the restored, committed manifests
    log "deps: npm install (without apn) ok"
  else
    log "deps: npm install failed (see $LOG_DIR/npm-install.log)"
  fi
}

# ---------------------------------------------------------------------------
# 2. Postgres, role and database
# ---------------------------------------------------------------------------
as_postgres() {
  if [ "$(id -u)" = "0" ]; then
    su postgres -c "$1"
  else
    sudo -n -u postgres sh -c "$1"
  fi
}

setup_postgres() {
  if ! command -v pg_isready >/dev/null 2>&1; then
    log "postgres: not installed, skipping"
    return 1
  fi
  if ! pg_isready -q -h localhost -p 5432; then
    log "postgres: starting"
    pg_ctlcluster 16 main start >"$LOG_DIR/pg-start.log" 2>&1 || log "postgres: pg_ctlcluster failed (see $LOG_DIR/pg-start.log)"
    for _ in $(seq 1 20); do pg_isready -q -h localhost -p 5432 && break; sleep 0.5; done
  fi
  if ! pg_isready -q -h localhost -p 5432; then
    log "postgres: not reachable on localhost:5432"
    return 1
  fi

  if [ "$(as_postgres "psql -tAc \"SELECT 1 FROM pg_roles WHERE rolname='fl'\"" 2>/dev/null)" != "1" ]; then
    as_postgres "psql -qc \"CREATE ROLE fl LOGIN PASSWORD 'fl' CREATEDB\"" && log "postgres: created role fl"
  fi
  if [ "$(as_postgres "psql -tAc \"SELECT 1 FROM pg_database WHERE datname='focusledger'\"" 2>/dev/null)" != "1" ]; then
    as_postgres "psql -qc \"CREATE DATABASE focusledger OWNER fl\"" && log "postgres: created database focusledger"
  fi
  log "postgres: ready"
  return 0
}

run_migrations() {
  if [ ! -d node_modules/pg ]; then
    log "migrate: node_modules/pg missing, skipping"
    return 0
  fi
  if DATABASE_URL="$LOCAL_DB_URL" node migrate.js >"$LOG_DIR/migrate.log" 2>&1; then
    if grep -q "\[migrate\] WARNING" "$LOG_DIR/migrate.log"; then
      log "migrate: finished with warnings (see $LOG_DIR/migrate.log)"
    else
      log "migrate: ok"
    fi
  else
    log "migrate: failed (see $LOG_DIR/migrate.log)"
  fi
}

# ---------------------------------------------------------------------------
# 3. Session env vars (kept if the environment already sets them)
# ---------------------------------------------------------------------------
write_env() {
  [ -n "${CLAUDE_ENV_FILE:-}" ] || return 0
  if grep -q "fl-session-start" "$CLAUDE_ENV_FILE" 2>/dev/null; then return 0; fi
  cat >>"$CLAUDE_ENV_FILE" <<EOF
# fl-session-start: local test defaults
export DATABASE_URL="\${DATABASE_URL:-$LOCAL_DB_URL}"
export JWT_SECRET="\${JWT_SECRET:-local-dev-jwt-secret}"
export SESSION_SECRET="\${SESSION_SECRET:-local-dev-session-secret}"
EOF
}

START=$(date +%s)
install_deps
if setup_postgres; then run_migrations; fi
write_env
log "done in $(( $(date +%s) - START ))s"
exit 0
