#!/usr/bin/env bash
#
# scripts/certify-class.sh — spend the minimum, and stop the moment a certificate becomes
# impossible.
#
# One class certificate is `m` measured attempts of one task class with `k` passes, recorded by
# the wall as a verdict and written by the store as a `class_certificates` row. This script runs
# the attempts, one `factory run` at a time, and stops for one of four named reasons:
#
#   failure-budget-exhausted  the (m - k + 1)th failure. At m - k failures the certificate can
#                             still exist if every remaining unit passes; one more failure and
#                             at most m - k - 1 of the m attempts can pass, so `passes >= k` is
#                             arithmetically impossible. Continuing would spend money to
#                             produce a decision that has already been made.
#   budget-refusal            `factory run` exited 6: the envelope refused the spend.
#   environment-refusal       `factory run` exited 8: the executor, the mirror or the key is not
#                             usable. Nothing was dispatched.
#   terminal-error            anything else that is not a clean pass or a measured fail — an
#                             unknown verdict, a unit that needs a person, an unexpected exit.
#                             The driver never guesses that an unmeasured attempt was a pass.
#
# Two more endings are not stops but completions: `operating-point-reached` (m attempts have been
# measured) and `units-exhausted` (the plan ran out before m attempts).
#
# ## The credential
#
# The gateway key is read **per run** over SSH into the environment of that single `factory run`.
# It is never written to disk, never echoed, never placed in an argument vector. `BIFROST_API_KEY`
# is set as a prefix assignment on the `factory` command, which is execve's env — not argv — so it
# does not appear in `ps`. The one place it exists is a shell variable's value, which is unset
# after each run.
#
# The line is substitutable for testing: `CERTIFY_KEY_COMMAND` names a program that prints the
# key on stdout. The default is the operator's SSH read. `e2e/certification/driver.test.ts`
# substitutes a stub whose printed value it then asserts appears nowhere in the transcript or on
# disk; it never runs the real line.
#
# ## What this driver deliberately does not do
#
# It does not submit or qualify units (that is the operator's planning step, and a driver that
# invented specs would be certifying its own homework). It does not accept `--force`, `-y` or any
# bypass flag: an argument beginning with `-` other than `--units-file`, `-h` and `--help` is a
# usage error. It does not edit the store, retry a unit, or widen a budget. And it does not decide
# whether the class is certified: the store does, and the script reads the store's answer with
# `factory audit --certifications` rather than predicting it from its own tally.
#
# Usage:
#   FACTORY_HOME=... FACTORY_HOLDOUT_ROOT=... FACTORY_HOLDOUT_TASK_CLASS=... \
#   FACTORY_PRISTINE_REPO=... FACTORY_REPO=... FACTORY_LIVE_MODEL=1 \
#     bash scripts/certify-class.sh --units-file units.txt
#
# Runbook: docs/runbooks/certify-class.md
set -uo pipefail

ROOT="${CERTIFY_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
cd "$ROOT" || exit 2

UNITS_FILE=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --units-file)
      shift
      UNITS_FILE="${1:-}"
      if [ -z "$UNITS_FILE" ]; then
        echo "certify-class: --units-file needs a path" >&2
        exit 2
      fi
      ;;
    -h | --help)
      sed -n '3,/^set -uo pipefail$/p' "${BASH_SOURCE[0]}" | sed '$d' | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      # A gate this script does not have cannot be asked for. Unknown flags are a usage error
      # (2), and `--force` / `-y` are just unknown flags here.
      echo "certify-class: unknown argument: $1 (no bypass flag exists; see --help)" >&2
      exit 2
      ;;
  esac
  shift
done

refuse_usage() {
  echo "certify-class: $1" >&2
  echo "certify-class: runbook: docs/runbooks/certify-class.md" >&2
  exit 2
}

# ---------------------------------------------------------------------------
# 1. Refuse before spending: the class, the corpus and the store must be named.
# ---------------------------------------------------------------------------

[ -n "${FACTORY_HOLDOUT_ROOT:-}" ] ||
  refuse_usage "FACTORY_HOLDOUT_ROOT is not set — without a holdout corpus there is no class to certify, and every verdict would be unknown (L3: unknown is not pass)"
[ -n "${FACTORY_HOLDOUT_TASK_CLASS:-}" ] ||
  refuse_usage "FACTORY_HOLDOUT_TASK_CLASS is not set — the corpus is filed under a task class, and a certificate names one"
[ -n "${FACTORY_HOME:-}" ] ||
  refuse_usage "FACTORY_HOME is not set — refusing to certify against an implicit store; point it at the store you intend to write"
[ -d "${FACTORY_HOME}" ] ||
  refuse_usage "FACTORY_HOME=${FACTORY_HOME} does not exist — create or point at the store you intend to certify (the driver will not invent one)"
[ -n "$UNITS_FILE" ] ||
  refuse_usage "--units-file is required: one pre-submitted, dark unit id per line"

[ -r "$UNITS_FILE" ] || refuse_usage "$UNITS_FILE is not readable"

NODE_BIN="${CERTIFY_NODE_BIN:-node}"
command -v "$NODE_BIN" >/dev/null 2>&1 ||
  refuse_usage "$NODE_BIN is not on PATH — the driver needs the pinned node (see .nvmrc)"

# The operating point is not this script's to invent: it is the ratified point the wall publishes.
# Reading it from the package means a change to the ratification moves the stop condition with it,
# instead of leaving the driver stopping at yesterday's m - k.
read -r M K < <(
  "$NODE_BIN" --input-type=module -e '
    import { DEFAULT_OPERATING_POINT } from "./packages/wall/src/index.ts";
    process.stdout.write(`${DEFAULT_OPERATING_POINT.m} ${DEFAULT_OPERATING_POINT.k}\n`);
  ' 2>/dev/null
)
if ! [[ "${M:-}" =~ ^[0-9]+$ && "${K:-}" =~ ^[0-9]+$ ]]; then
  refuse_usage "could not read the operating point from packages/wall (m=${M:-?} k=${K:-?}); refusing to guess a stop condition"
fi

# The corpus must be usable *now*: a loop that spends twenty units against a manifest the loader
# refuses would produce twenty `holdout_unavailable` verdicts and no certificate.
if ! "$NODE_BIN" --input-type=module -e '
  import { loadHoldout } from "./packages/wall/src/index.ts";
  const [root, taskClass] = process.argv.slice(1);
  const store = loadHoldout(root, taskClass);
  if (store === null) process.exit(1);
  process.stdout.write(`${store.taskClass}@${store.revision} scenarios=${store.scenarios.length}`);
' "$FACTORY_HOLDOUT_ROOT" "$FACTORY_HOLDOUT_TASK_CLASS" 2>/dev/null >/tmp/.certify-class-corpus.$$; then
  rm -f "/tmp/.certify-class-corpus.$$"
  refuse_usage "no usable holdout corpus for \"${FACTORY_HOLDOUT_TASK_CLASS}\" under ${FACTORY_HOLDOUT_ROOT} — the wall would report holdout_unavailable and no verdict could pass"
fi
CORPUS="$(cat "/tmp/.certify-class-corpus.$$")"
rm -f "/tmp/.certify-class-corpus.$$"

# The failure arithmetic, named once. `m - k` failures are *tolerable*: the remaining units can
# still reach k passes. The next failure makes `passes >= k` impossible, and that is the stop.
ALLOWED_FAILURES=$((M - K))
STOP_AFTER_FAILURES=$((ALLOWED_FAILURES + 1))

# ---------------------------------------------------------------------------
# 2. The CLI, and the credential command (substitutable for tests).
# ---------------------------------------------------------------------------

# The CLI entry point. Defaults to this checkout's, because `factory` is not installed on PATH
# here; an operator with an installed CLI sets this to its entry module.
FACTORY_ENTRY="${CERTIFY_FACTORY_ENTRY:-$ROOT/apps/cli/src/main.ts}"
[ -f "$FACTORY_ENTRY" ] || refuse_usage "CERTIFY_FACTORY_ENTRY=${FACTORY_ENTRY} is not a file"

factory() {
  "$NODE_BIN" "$FACTORY_ENTRY" "$@"
}

# The one line that touches the gateway key. It prints the key on stdout and nothing else.
# `CERTIFY_KEY_COMMAND` replaces it with a stub in tests; the default is the operator's read.
read_credential() {
  if [ -n "${CERTIFY_KEY_COMMAND:-}" ]; then
    "$CERTIFY_KEY_COMMAND"
  else
    ssh -o BatchMode=yes hermes-control cat \
      /home/bo/.hermes/bifrost/program-secrets/software-factory-dsh/credential
  fi
}

# Where the factory's own output for one unit is kept between runs. Under the factory home, not
# /tmp: an operator investigating a stop needs the evidence next to the store. The credential
# never reaches these files — the CLI does not print it.
LOG_DIR="${FACTORY_HOME}/certification"
mkdir -p "$LOG_DIR" || refuse_usage "cannot create ${LOG_DIR}"

# ---------------------------------------------------------------------------
# 3. The loop.
# ---------------------------------------------------------------------------

attempts=0
passes=0
failures=0
stop_reason=""
rows=()

# Every unit line: <unitId> <exit> <outcome> <passes> <failures> <attempts>
row() {
  rows+=("$(printf '%-22s %-4s %-11s %-6s %-8s %s' "$1" "$2" "$3" "$4" "$5" "$6")")
}

# Read the machine-readable body the CLI prints, falling back to the exit code. The body is
# authoritative where it exists: exit 3 means both "the verdict was fail" and "the lane was not
# dark", and only the body can tell them apart. Fields are separated by 0x1f rather than a space
# because `read` strips leading whitespace, which turned an empty outcome into the error code.
classify() {
  local file="$1" code="$2" outcome kind needs
  outcome=""
  kind=""
  needs=""
  if [ -s "$file" ]; then
    IFS=$'\x1f' read -r outcome kind needs < <(
      "$NODE_BIN" -e '
        const fs = require("node:fs");
        let body = {};
        try { body = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); } catch { process.exit(0); }
        const outcome = typeof body.outcome === "string" ? body.outcome : "";
        const kind = typeof body.code === "string" ? body.code : "";
        const needs = body.needsPerson === true ? "1" : "";
        process.stdout.write(`${outcome}\x1f${kind}\x1f${needs}`);
      ' "$file" 2>/dev/null || true
    )
  fi
  case "$outcome" in
    pass | fail)
      printf '%s\n' "$outcome"
      return 0
      ;;
    unknown)
      if [ -n "$needs" ]; then printf 'needs-person\n'; else printf 'unknown\n'; fi
      return 0
      ;;
  esac
  # No verdict in the body: the CLI refused, and its error code is the most specific fact.
  if [ "$kind" = "BUDGET_EXCEEDED" ]; then
    printf 'budget-refusal\n'
    return 0
  fi
  if [ "$code" -eq 8 ]; then
    printf 'environment-refusal\n'
    return 0
  fi
  if [ -n "$kind" ]; then
    printf 'error:%s\n' "$kind"
    return 0
  fi
  case "$code" in
    0) printf 'pass\n' ;;
    3) printf 'fail\n' ;;
    4) printf 'unknown\n' ;;
    5) printf 'needs-person\n' ;;
    6) printf 'budget-refusal\n' ;;
    *) printf 'error:%s\n' "$code" ;;
  esac
}

echo "certify-class: corpus ${CORPUS}"
echo "certify-class: class ${FACTORY_HOLDOUT_TASK_CLASS}, operating point m=${M} k=${K}"
echo "certify-class: allowed failures ${ALLOWED_FAILURES}; the cert cannot exist after ${STOP_AFTER_FAILURES}"
echo "certify-class: store ${FACTORY_HOME}"
if [ "${FACTORY_LIVE_MODEL:-}" != "1" ]; then
  echo "certify-class: note: FACTORY_LIVE_MODEL is not 1 — this loop will not authorise a model call"
fi
echo "certify-class: units ${UNITS_FILE}"
echo ""

while IFS= read -r raw_unit || [ -n "$raw_unit" ]; do
  unitId="${raw_unit%%#*}"
  unitId="$(printf '%s' "$unitId" | tr -d '\r' | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')"
  [ -n "$unitId" ] || continue

  if [ "$attempts" -ge "$M" ]; then
    stop_reason="operating-point-reached"
    break
  fi

  # `</dev/null` again, and for the same reason as the run below: `ssh` reads stdin, and the
  # loop's stdin is the units file. Without this the key read eats the plan, which is exactly the
  # failure the first two live attempts reported as `units-exhausted` after a single unit.
  credential="$(read_credential 2>/dev/null </dev/null)"
  credential_status=$?
  if [ "$credential_status" -ne 0 ] || [ -z "$credential" ]; then
    stop_reason="credential-unavailable"
    echo "certify-class: stopped: credential-unavailable — ${unitId} was not dispatched: the credential command exited ${credential_status} or printed nothing" >&2
    break
  fi

  stdout_file="${LOG_DIR}/${unitId}.stdout.json"
  stderr_file="${LOG_DIR}/${unitId}.stderr.log"
  run_args=(run "$unitId" --json)
  # The scripted executor is the offline proof's worker, and it needs one scenario per unit.
  # A live run never takes this branch (`probeExecutor` refuses `fake` outside tests), and it is
  # keyed on an explicit `FACTORY_EXECUTOR=fake` so a paid loop can neither reach it by accident
  # nor be steered by a stray file.
  if [ "${FACTORY_EXECUTOR:-}" = "fake" ] && [ -f "${FACTORY_HOME}/scenarios/${unitId}.json" ]; then
    run_args+=(--scenario "${FACTORY_HOME}/scenarios/${unitId}.json")
  fi

  # The credential exists only for this command: a prefix assignment is the child's environment,
  # never its argv, so `ps` cannot see it. Spelled out rather than routed through the `factory`
  # helper on purpose: a prefix assignment on a *function* call is a bash quirk that the next
  # reader would have to know about, and this line is the one that must be obviously correct.
  # `</dev/null` is load-bearing, not hygiene: the loop's stdin *is* the units file, and a child
  # that reads a byte of it silently swallows the rest of the plan. The first live run of this
  # driver measured exactly one unit and reported `units-exhausted` with eighteen lines still in
  # the file, because the worker's own `dsh` consumed the units-file descriptor it inherited.
  BIFROST_API_KEY="$credential" "$NODE_BIN" "$FACTORY_ENTRY" "${run_args[@]}" \
    >"$stdout_file" 2>"$stderr_file" </dev/null
  code=$?
  unset credential

  attempts=$((attempts + 1))
  outcome="$(classify "$stdout_file" "$code")"
  case "$outcome" in
    pass)
      passes=$((passes + 1))
      row "$unitId" "$code" "pass" "$passes" "$failures" "$attempts"
      ;;
    fail)
      failures=$((failures + 1))
      row "$unitId" "$code" "fail" "$passes" "$failures" "$attempts"
      ;;
    budget-refusal)
      row "$unitId" "$code" "budget-refusal" "$passes" "$failures" "$attempts"
      stop_reason="budget-refusal"
      ;;
    environment-refusal)
      row "$unitId" "$code" "environment-refusal" "$passes" "$failures" "$attempts"
      stop_reason="environment-refusal"
      ;;
    unknown | needs-person)
      row "$unitId" "$code" "$outcome" "$passes" "$failures" "$attempts"
      stop_reason="unmeasured-attempt"
      ;;
    *)
      row "$unitId" "$code" "$outcome" "$passes" "$failures" "$attempts"
      stop_reason="terminal-error"
      ;;
  esac

  if [ -z "$stop_reason" ] && [ "$failures" -ge "$STOP_AFTER_FAILURES" ]; then
    stop_reason="failure-budget-exhausted"
  fi
  if [ -n "$stop_reason" ]; then
    echo "certify-class: stopped: ${stop_reason}" >&2
    # The factory's own last words are the diagnosis, and they never contain the credential.
    if [ -s "$stderr_file" ]; then
      tail -n 6 "$stderr_file" | sed 's/^/certify-class:   /' >&2
    fi
    break
  fi
done <"$UNITS_FILE"

if [ -z "$stop_reason" ] && [ "$attempts" -lt "$M" ]; then
  stop_reason="units-exhausted"
fi
if [ -z "$stop_reason" ]; then
  stop_reason="operating-point-reached"
fi

# ---------------------------------------------------------------------------
# 4. The final table, and the store's answer — not the driver's guess.
# ---------------------------------------------------------------------------

echo ""
echo "certify-class: per-unit"
printf '%-22s %-4s %-11s %-6s %-8s %s\n' "unit" "exit" "outcome" "passes" "failures" "attempts"
if [ "${#rows[@]}" -gt 0 ]; then
  for line in "${rows[@]}"; do
    printf '%s\n' "$line"
  done
fi
echo ""
echo "certify-class: measured ${attempts} of ${M} attempts: ${passes} pass, ${failures} fail; stop ${stop_reason}"
echo "certify-class: allowed failures ${ALLOWED_FAILURES} (m - k); a certificate becomes impossible at ${STOP_AFTER_FAILURES}"

audit_file="$(mktemp)"
factory audit --certifications --json >"$audit_file" 2>/dev/null
"$NODE_BIN" -e '
  const fs = require("node:fs");
  const path = process.argv[1];
  const taskClass = process.argv[2];
  let body;
  try {
    body = JSON.parse(fs.readFileSync(path, "utf8"));
  } catch {
    process.stdout.write("certificate: the store could not be read; certification is UNKNOWN\n");
    process.exit(3);
  }
  const classes = Array.isArray(body.classes) ? body.classes : [];
  const row = classes.find((entry) => entry.taskClass === taskClass);
  if (row === undefined) {
    process.stdout.write(
      `certificate: class ${taskClass} is never-certified in this store: no certificate row exists\n`,
    );
    process.exit(1);
  }
  process.stdout.write(
    `certificate: class ${row.taskClass} state=${String(row.state)} outcome=${String(row.outcome)} ` +
      `samples=${String(row.samples)} m=${String(row.m)} alpha=${String(row.alpha)}\n`,
  );
  process.exit(row.state === "current" ? 0 : 1);
' "$audit_file" "${FACTORY_HOLDOUT_TASK_CLASS}"
certificate_code=$?
rm -f "$audit_file"

# The store's answer outranks the driver's reason for stopping: a loop that stopped because its
# plan ran out, but whose store nonetheless holds a current certificate for the class, achieved
# the goal and must say so.
if [ "$certificate_code" -eq 0 ]; then exit 0; fi
case "$stop_reason" in
  budget-refusal) exit 6 ;;
  environment-refusal | credential-unavailable) exit 8 ;;
  units-exhausted) exit 2 ;;
  unmeasured-attempt) exit 5 ;;
  terminal-error) exit 1 ;;
esac
exit 1
