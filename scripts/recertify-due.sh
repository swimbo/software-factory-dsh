#!/usr/bin/env bash
#
# scripts/recertify-due.sh — the scheduled re-certification, with the spend fenced.
#
# The detection half of re-certification has shipped for a long time: `factory alerts` emits
# `CERT_STALE`/`CERT_NEVER` every night at 04:00 and names the driver. This script is the half that can
# act on it, and it exists in the form the round list asked for: scheduled, and *capable* of spending,
# but only for a class the operator has given a token budget.
#
#   (no flags)  plan only. Prints each due class, the measured projection and the decision. Spends
#               nothing, always. This is what a person runs to see what auto-spend would do.
#   --spend     for each class whose plan decision is `would-spend`, run `scripts/certify-class.sh`
#               with that class's units file. Every other decision is printed and skipped: a missing
#               budget, an unknown estimate, an over-budget projection and a missing units file are
#               all refusals, and a refusal here costs nothing.
#
# ## Why the budget is per class
#
# The measured cost of a full certificate is not one number: `docs-typo-fix` ran 186,787 tokens and
# `type-repair` 1,944,675 — a 10× spread. One global cap either starves the cheap class or lets the
# expensive one run unbounded, so the operator's control is a per-class map:
#
#   FACTORY_RECERTIFY_BUDGET_TOKENS="docs-hygiene=2000000,type-repair=2500000"
#
# Unset is the default and means "no class may spend", which is why a job can exist before a spender
# does. A malformed entry is a usage error in the audit (a typo must not silently drop a cap).
#
# ## What this script deliberately does not do
#
# It does not compute the projection (the CLI does, from the store's usage facts), it does not decide
# that a class is certified (the store does), and it invents no specs: a class with no pre-submitted
# units file is refused by the plan, not by the driver. It does not retry a failed run, and it has no
# `--force`: an argument beginning with `-` other than `--spend`, `-h` and `--help` is a usage error.
#
# Usage:
#   FACTORY_HOME=... bash scripts/recertify-due.sh            # plan only
#   FACTORY_HOME=... FACTORY_RECERTIFY_UNITS_DIR=... \
#     FACTORY_RECERTIFY_BUDGET_TOKENS="<class>=<tokens>" \
#     bash scripts/recertify-due.sh --spend
#
# Runbook: docs/runbooks/certify-class.md
set -uo pipefail

ROOT="${RECERTIFY_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
cd "$ROOT" || exit 2

SPEND=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --spend) SPEND=1 ;;
    -h | --help)
      sed -n '3,/^set -uo pipefail$/p' "${BASH_SOURCE[0]}" | sed '$d' | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "recertify-due: unknown argument: $1 (no bypass flag exists; see --help)" >&2
      exit 2
      ;;
  esac
  shift
done

refuse_usage() {
  echo "recertify-due: $1" >&2
  echo "recertify-due: runbook: docs/runbooks/certify-class.md" >&2
  exit 2
}

NODE_BIN="${RECERTIFY_NODE_BIN:-node}"
command -v "$NODE_BIN" >/dev/null 2>&1 ||
  refuse_usage "$NODE_BIN is not on PATH — the plan needs the pinned node (see .nvmrc)"

[ -n "${FACTORY_HOME:-}" ] ||
  refuse_usage "FACTORY_HOME is not set — refusing to plan against an implicit store; point it at the store you intend to act on"
[ -d "${FACTORY_HOME}" ] ||
  refuse_usage "FACTORY_HOME=${FACTORY_HOME} does not exist — create or point at the store you intend to act on"

# The plan is the CLI's, not this script's: one projection implementation, one budget parser. A test
# substitutes RECERTIFY_CLI to feed a fixed plan without a store.
CLI_CMD="${RECERTIFY_CLI:-$NODE_BIN apps/cli/src/main.ts}"
PLAN_JSON="$(
  # shellcheck disable=SC2086 # CLI_CMD is a command line, intentionally word-split
  $CLI_CMD audit --certifications --json 2>/dev/null
)"
if [ -z "$PLAN_JSON" ]; then
  echo "recertify-due: the audit produced no plan; refusing to spend on a plan it could not read" >&2
  exit 9
fi

# The runner is the driver; a test substitutes RECERTIFY_RUNNER with a stub that records its argv.
RUNNER="${RECERTIFY_RUNNER:-bash scripts/certify-class.sh}"

# One line per entry: decision, class, remaining, projected tokens, budget, units file. Tab-separated so
# a class name cannot collide with the fields, and read with IFS.
PLAN_LINES="$(
  printf '%s' "$PLAN_JSON" |
    "$NODE_BIN" --input-type=module -e '
      let raw = "";
      for await (const chunk of process.stdin) raw += chunk;
      const payload = JSON.parse(raw);
      const entries = (payload.recertification && payload.recertification.entries) || [];
      for (const entry of entries) {
        const estimate = entry.estimate || {};
        const projected = estimate.projectedTokens === null ? "" : String(estimate.projectedTokens);
        const budget = entry.budgetTokens === null ? "" : String(entry.budgetTokens);
        const units = entry.unitsFile === null ? "" : entry.unitsFile;
        process.stdout.write(
          [entry.decision, entry.taskClass, String(entry.remaining), projected, budget, units].join("\t") + "\n",
        );
      }
    '
)" || {
  echo "recertify-due: the plan could not be read; refusing to spend on it" >&2
  exit 9
}

SPENDABLE=0
REFUSED=0
CURRENT=0
spent_classes=()

while IFS=$'\t' read -r decision task_class remaining projected budget units_file; do
  [ -n "${decision:-}" ] || continue
  case "$decision" in
    not-due) CURRENT=$((CURRENT + 1)) ;;
    would-spend)
      SPENDABLE=$((SPENDABLE + 1))
      echo "recertify-due: ${task_class}: due, ${remaining} attempt(s), projected ${projected} tokens, budget ${budget} — would spend"
      if [ "$SPEND" -eq 1 ]; then
        echo "recertify-due: spending on ${task_class} via: ${RUNNER} --units-file ${units_file}"
        # The class is named per run, exactly as the driver expects it: a certificate is filed under
        # the class the wall is configured with, and this export is that configuration for this run.
        # shellcheck disable=SC2086 # RUNNER is a command line, intentionally word-split
        if FACTORY_HOLDOUT_TASK_CLASS="$task_class" $RUNNER --units-file "$units_file"; then
          spent_classes+=("$task_class")
          echo "recertify-due: ${task_class}: driver finished"
        else
          echo "recertify-due: ${task_class}: driver FAILED; not retrying (the next run is the retry)" >&2
          exit 1
        fi
      fi
      ;;
    refused-*)
      REFUSED=$((REFUSED + 1))
      echo "recertify-due: ${task_class}: ${decision} — not spending (${task_class}: ${remaining} attempt(s) needed)"
      ;;
    *)
      echo "recertify-due: ${task_class}: unknown decision ${decision}; refusing to act on it" >&2
      exit 9
      ;;
  esac
done <<EOF
$PLAN_LINES
EOF

echo "recertify-due: ${CURRENT} current, ${SPENDABLE} spendable, ${REFUSED} refused (spend=$SPEND)"

if [ "${#spent_classes[@]}" -gt 0 ]; then
  # The operator hears about a spend on the same channel as every other alert, and the alert verb is
  # the only delivery path: one notification transport, not two.
  echo "recertify-due: spent on ${spent_classes[*]}; raising the alert notification"
  # shellcheck disable=SC2086 # CLI_CMD is a command line, intentionally word-split
  $CLI_CMD alerts --notify || echo "recertify-due: alert delivery failed; the store is the record" >&2
fi

# Exit 0 means "nothing was left undone by this script": a refusal is the plan's answer, and the
# nightly `factory alerts` job is what tells a person about it (one alarm, not two).
exit 0
