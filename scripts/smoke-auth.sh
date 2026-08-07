#!/usr/bin/env bash
# Smoke-test the Better Auth migration against a running local server.
# Usage: npm run dev  (in one terminal), then: bash scripts/smoke-auth.sh
set -euo pipefail
BASE="${BASE:-http://localhost:3001}"
pass() { printf '  \033[32m✓\033[0m %s\n' "$1"; }
fail() { printf '  \033[31m✗\033[0m %s\n' "$1"; exit 1; }

echo "1. OAuth authorization-server metadata"
as=$(curl -fsS "$BASE/.well-known/oauth-authorization-server")
echo "$as" | grep -q '"issuer"' && pass "issuer present: $(echo "$as" | grep -o '"issuer":"[^"]*"')" || fail "no issuer"

echo "2. Protected-resource metadata (points at this server)"
curl -fsS "$BASE/.well-known/oauth-protected-resource" | grep -q '"authorization_servers"' \
  && pass "authorization_servers present" || fail "missing PRM"

echo "3. JWKS serves a key"
curl -fsS "$BASE/api/auth/jwks" | grep -q '"keys"' && pass "JWKS has keys" || fail "no JWKS keys"

echo "4. Magic-link send (no RESEND_API_KEY in dev → link logged in server console)"
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/auth/sign-in/magic-link" \
  -H 'content-type: application/json' -d '{"email":"ijonathanvs@gmail.com"}')
[ "$code" = "200" ] && pass "magic-link accepted (200) — check server log for the link" \
  || fail "magic-link returned $code"

echo "5. /api/audios rejects anonymous (401)"
code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/audios")
[ "$code" = "401" ] && pass "unauthenticated → 401 (Bearer required)" || fail "expected 401, got $code"

printf '\n\033[32mAll checks passed.\033[0m Better Auth is wired correctly.\n'
