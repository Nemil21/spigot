#!/usr/bin/env bash
# Secret scan: gitleaks over the full git history (every ref), values redacted.
# Fails on any hit. Uses a local `gitleaks` if installed, else the official Docker image.
# Config: .gitleaks.toml (default rules + path-scoped test allowlists). Remaining known false
# positives are pinned by fingerprint in .gitleaksignore.
#   npm run security:secrets
set -euo pipefail
root="$(git rev-parse --show-toplevel)"
cd "$root"
args=(git --log-opts="--all" --redact --no-banner --exit-code 1)
if command -v gitleaks >/dev/null 2>&1; then
  exec gitleaks "${args[@]}" --config .gitleaks.toml --gitleaks-ignore-path .gitleaksignore .
fi
# A linked worktree's .git is a file pointing into the main repo: mount the common git dir too.
common="$(cd "$(git rev-parse --git-common-dir)" && pwd)"
exec docker run --rm ${AO_SESSION_ID:+--label ao.session=$AO_SESSION_ID} \
  -v "$root":/repo:ro -v "$common":"$common":ro -w /repo \
  -e GIT_CONFIG_COUNT=1 -e GIT_CONFIG_KEY_0=safe.directory -e GIT_CONFIG_VALUE_0='*' \
  zricethezav/gitleaks:v8.30.1 "${args[@]}" --config /repo/.gitleaks.toml --gitleaks-ignore-path /repo/.gitleaksignore /repo
