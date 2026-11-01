#!/usr/bin/env bash
#
# The `lint` gate.
#
# Why this is not ESLint: `tech-guide.md` §56 specified `@typescript-eslint`, and
# `typescript-eslint@8.72.1` refuses to load under `typescript@7.0.2`
# ("typescript-eslint does not support TS 7.0"). Its flat config also needs `jiti`,
# which is not installable in this offline environment. Rather than ship a gate that
# exits 2 forever, or silently drop the stage, this replaces it with the checks this
# codebase actually depends on — the discipline rules that hold the three laws
# together. They are grep-level on purpose: deterministic, no parser, no network.
#
# Each check has an explicit allowlist. An allowlist entry is a decision with a
# reason, not a mute button; the lists are reviewed when a file moves.
set -uo pipefail

cd "$(dirname "$0")/.." || exit 1

FAILED=0
CHECKED=0

# Paths exempt from the production-code rules: tests (which must construct malformed
# values), the e2e suite (which drives processes), and this script (whose pattern table
# has to contain the patterns it looks for).
NON_PRODUCTION='\.test\.ts:|/tests?/|/e2e/|^scripts/discipline-lint\.sh:'

TARGETS=$(find packages apps e2e scripts -type f \( -name '*.ts' -o -name '*.sh' \) \
  -not -path '*/node_modules/*' -not -path '*/dist/*' 2>/dev/null | sort)
if [ -z "$TARGETS" ]; then
  echo "discipline-lint: no tracked sources found — run from the repo root" >&2
  exit 8
fi

fail() {
  local check="$1"
  shift
  echo "FAIL  $check"
  for line in "$@"; do echo "      $line"; done
  FAILED=$((FAILED + 1))
}

report() {
  CHECKED=$((CHECKED + 1))
  echo "ok    $1"
}

# 1. A suppressed type error must be justified on the same line. A bare
#    @ts-expect-error is how a real type failure becomes a shipped bug.
hits=$(printf '%s\n' "$TARGETS" | xargs grep -nH '@ts-expect-error' 2>/dev/null \
  | grep -vE "$NON_PRODUCTION" \
  | grep -vE '//[[:space:]]*@ts-expect-error' \
  | grep -vE '@ts-expect-error[[:space:]]+[A-Za-z].*\.' || true)
if [ -n "$hits" ]; then fail "every @ts-expect-error carries a reason" "$hits"; else report "no unjustified @ts-expect-error"; fi

# 2. `as any` in production code erases the contract that everything else relies on.
hits=$(printf '%s\n' "$TARGETS" | xargs grep -nH 'as any' 2>/dev/null | grep -vE "$NON_PRODUCTION" || true)
if [ -n "$hits" ]; then fail "no \`as any\` outside tests" "$hits"; else report "no \`as any\` outside tests"; fi

# 3. A skipped or focused test hides work. `.skip` on a control test is how a red
#    control becomes a green suite.
hits=$(printf '%s\n' "$TARGETS" | xargs grep -nHE '(\bit|\bdescribe|\btest)\.(only|skip)\(' 2>/dev/null | grep -vE 'skipIf|skip:\s*[a-z]' || true)
if [ -n "$hits" ]; then fail "no .only / .skip in tests (use skipIf with a reason)" "$hits"; else report "no .only / .skip in tests"; fi

# 4. eslint-disable comments would contradict the config above; there is no ESLint.
hits=$(printf '%s\n' "$TARGETS" | xargs grep -nH 'eslint-disable' 2>/dev/null | grep -vE "$NON_PRODUCTION" || true)
if [ -n "$hits" ]; then fail "no eslint-disable comments" "$hits"; else report "no eslint-disable comments"; fi

# 5. `Date.now()` is allowed only where a real clock is unavoidable: process
#    entrypoints, test helpers, and the one gate clock deliberately isolated for
#    auditing. Everything else takes an injected `now` — that is what makes replay
#    and the deterministic qualifier real. The fake executor is allowlisted because a
#    scripted `hang` needs a real elapsed interval to hang for; it measures nothing
#    that reaches the ledger.
ALLOW_CLOCK='(^|/)(main|cli|helpers?|fixtures?)\.ts:|\.test\.ts:|/tests?/|packages/gates/src/decision\.ts:|packages/wall/src/container\.ts:|apps/panel/src/dsh-version\.ts:|^scripts/discipline-lint\.sh:|^scripts/verify\.sh:|e2e/panel/harness/|packages/wall/src/local\.ts:|packages/dsh-adapter/src/fake-executor\.ts:'
hits=$(printf '%s\n' "$TARGETS" | xargs grep -nH 'Date\.now(' 2>/dev/null | grep -vE "$ALLOW_CLOCK" || true)
if [ -n "$hits" ]; then fail "no Date.now() outside allowlisted clock sites" "$hits"; else report "no Date.now() outside allowlisted clock sites"; fi

# 6. `process.env` may be read only in composition roots and probes; a control that
#    reads its own environment can be reconfigured from outside the policy.
ALLOW_ENV='(^|/)(main|context|preflight|verify|testing|helpers?)\.(ts|sh):|\.test\.ts:|/tests?/|apps/panel/src/token\.ts:|apps/panel/src/dsh-version\.ts:|packages/dsh-adapter/src/(overlay|executor|home)\.ts:|^scripts/discipline-lint\.sh:|^scripts/verify\.sh:|e2e/panel/harness/|packages/wall/src/local\.ts:|packages/dsh-adapter/src/fake-executor\.ts:'
hits=$(printf '%s\n' "$TARGETS" | xargs grep -nH 'process\.env\.' 2>/dev/null | grep -vE "$ALLOW_ENV" || true)
if [ -n "$hits" ]; then fail "process.env read only at composition roots" "$hits"; else report "process.env read only at composition roots"; fi

# 7. The factory must never import the harness SDK directly: DSH is reached through
#    the adapter, so the pin is enforced in one place.
hits=$(printf '%s\n' "$TARGETS" | xargs grep -nH "from '@deepseek-ai/\|require('@deepseek-ai/" 2>/dev/null | grep -vE 'packages/dsh-adapter/' || true)
if [ -n "$hits" ]; then fail "no DSH package imports outside the adapter" "$hits"; else report "no DSH package imports outside the adapter"; fi

echo
if [ "$FAILED" -eq 0 ]; then
  echo "discipline-lint: $CHECKED checks passed"
  exit 0
fi
echo "discipline-lint: $FAILED of $((CHECKED + FAILED)) checks failed" >&2
exit 1
