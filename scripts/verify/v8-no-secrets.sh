#!/usr/bin/env bash
set -euo pipefail

fail=0

# Patterns that must not appear in any committed file.
# sk-ant- requires actual key material (type + 20+ chars) to avoid false-positives
# on validation prefix constants in source code (e.g. kAnthropicApiKeyPrefix).
PATTERNS=(
  'SETUP_PASSWORD=[^$"\x27<\[]'      # literal password value (not a shell variable ref or placeholder)
  'GITHUB_TOKEN=gh[pos]_'            # actual GitHub token
  'sk-ant-[a-zA-Z0-9]+-[a-zA-Z0-9_-]{20,}'  # actual Anthropic API key (prefix + type + key material)
  'DEEPSEEK_API_KEY=[^$"\x27<\[]'   # literal DeepSeek key
)

for pat in "${PATTERNS[@]}"; do
  MATCHES=$(git grep -rE "$pat" -- ':!*.md' ':!tests/' ':!requirements/' ':!scripts/verify/v8-no-secrets.sh' 2>/dev/null || true)
  if [[ -n "$MATCHES" ]]; then
    echo "FAIL: secret pattern found: $pat"
    echo "$MATCHES"
    fail=1
  fi
done

# data-seed/.env must be gitignored (never committed)
if git ls-files --error-unmatch data-seed/.env 2>/dev/null; then
  echo "FAIL: data-seed/.env is tracked by git — it must be gitignored"
  fail=1
else
  echo "PASS: data-seed/.env is not tracked by git"
fi

[[ $fail -eq 0 ]] && echo "PASS: no secrets found in committed files"
exit $fail
