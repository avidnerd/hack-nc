#!/usr/bin/env bash
# Fails if staged changes (or, with --all, tracked files / a build dir) contain
# something that looks like an API key. Wired as .githooks/pre-commit:
#   git config core.hooksPath .githooks
set -euo pipefail
PATTERNS='(sk-[A-Za-z0-9_-]{20,}|tvly-[A-Za-z0-9_-]{16,}|hf_[A-Za-z0-9]{30,}|AIza[0-9A-Za-z_-]{35}|eyJ[A-Za-z0-9_-]{30,}\.[A-Za-z0-9_-]{20,}|(NEBIUS|TAVILY|HF|GEMINI|ANTHROPIC)[A-Z_]*(KEY|TOKEN|SECRET)[A-Z_]*\s*[:=]\s*["'"'"']?[A-Za-z0-9_\-]{16,})'
case "${1:-}" in
  --all) hits=$(git grep -nIE "$PATTERNS" -- ':!package-lock.json' ':!site/package-lock.json' ':!backend/uv.lock' ':!scripts/check-secrets.sh' || true) ;;
  --dir) hits=$(grep -rnIE "$PATTERNS" "$2" || true) ;;
  *)     hits=$(git diff --cached -U0 --no-color -- ':!scripts/check-secrets.sh' ':!*.lock' ':!*package-lock.json' | grep -E '^\+' | grep -E "$PATTERNS" || true) ;;
esac
if [[ -n "$hits" ]]; then
  echo "check-secrets: possible secret found:" >&2
  echo "$hits" | cut -c1-160 >&2
  exit 1
fi
