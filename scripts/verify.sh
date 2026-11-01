#!/usr/bin/env bash
# Verification harness for the dark-software-factory plan (Phases 11-12).
#
# One command, fail-closed, no network. It runs the repository's own gates in the order a
# merge would: preflight -> typecheck -> lint -> format:check -> tests -> build, prints a
# PASS/FAIL table with each stage's exact command and exit code, and writes both a full log
# and a machine-readable summary under docs/verification/<timestamp>/.
#
# Two things are deliberately *not* failures:
#
#   * a missing `dsh` binary — this repository is verified on a machine that may not have the
#     harness installed; the preflight stage is then SKIPPED with a reason, and every other
#     stage still runs (the dsh-dependent tests skip themselves, see
#     packages/dsh-adapter/tests/profile.test.ts);
#   * a missing `BIFROST_API_KEY` — the offline suite never needs it. The `live-model` row
#     exists so that its absence is recorded as SKIPPED rather than quietly unnoticed: live
#     model tests are excluded from this harness *by design* (no network), not by omission.
#
# What IS a failure: a red stage caused by the code. The harness never skips a stage to make
# the table green, and never rewrites a test. It exits non-zero if anything failed.
#
# Usage:
#   bash scripts/verify.sh            # human table on stdout, log + summary on disk
#   bash scripts/verify.sh --json     # the summary JSON on stdout and nothing else
#   bash scripts/verify.sh --out-dir docs/verification/my-run   # fixed output directory
#
# The ambient toolchain is used as-is: run it with the node pinned in .nvmrc (26.12.1). Under
# an older node the preflight stage fails, which is the intended fail-closed behaviour — the
# harness does not paper over a wrong runtime.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

json_mode=0
out_dir=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --json) json_mode=1 ;;
    --out-dir)
      shift
      out_dir="${1:-}"
      if [ -z "$out_dir" ]; then
        echo "verify: --out-dir needs a directory" >&2
        exit 2
      fi
      ;;
    -h | --help)
      sed -n '2,30p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "verify: unknown argument: $1" >&2
      exit 2
      ;;
  esac
  shift
done

stamp="$(date -u +%Y-%m-%dT%H-%M-%SZ)"
run_dir="${out_dir:-docs/verification/$stamp}"
log_file="$run_dir/verify.log"
summary_file="$run_dir/summary.json"
stages_file="$run_dir/.stages.jsonl"
mkdir -p "$run_dir"
: >"$log_file"
: >"$stages_file"

# Everything the operator sees (unless --json) is also in the log.
say() {
  printf '%s\n' "$*" >>"$log_file"
  if [ "$json_mode" -eq 0 ]; then printf '%s\n' "$*"; fi
}

say "verify: plan dark-factory-dsh, run $stamp"
say "verify: repo $ROOT"
say "verify: log $log_file"
say ""

now_ms() { node -e 'process.stdout.write(String(Date.now()))' 2>/dev/null || printf '0'; }

# --- environment facts (never values, only presence) -----------------------------------
dsh_bin="${FACTORY_DSH_BIN:-/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh}"
if [ -x "$dsh_bin" ]; then dsh_available=1; else dsh_available=0; fi
dsh_version=""
if [ "$dsh_available" -eq 1 ]; then
  dsh_version="$("$dsh_bin" --version 2>/dev/null | head -1 || true)"
fi

node_version="$(node -v 2>/dev/null || printf 'absent')"
pnpm_version="$(pnpm --version 2>/dev/null || printf 'absent')"
git_branch="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || printf 'unknown')"
git_head="$(git rev-parse --short HEAD 2>/dev/null || printf 'unknown')"
git_dirty="$(git status --porcelain 2>/dev/null | wc -l | tr -d ' ')"

key_present() {
  if [ -n "${!1:-}" ]; then printf 'true'; else printf 'false'; fi
}
bifrost_present="$(key_present BIFROST_API_KEY)"
deepseek_present="$(key_present DEEPSEEK_API_KEY)"

say "verify: node $node_version, pnpm $pnpm_version, git $git_branch@$git_head ($git_dirty dirty paths)"
if [ "$dsh_available" -eq 1 ]; then
  say "verify: dsh $dsh_version at $dsh_bin"
else
  say "verify: dsh not installed (looked for $dsh_bin) — preflight will be SKIPPED"
fi
say "verify: BIFROST_API_KEY $([ "$bifrost_present" = true ] && printf 'set' || printf 'not set'), DEEPSEEK_API_KEY $([ "$deepseek_present" = true ] && printf 'set' || printf 'not set')"
say ""

# --- the node floor preflight enforces; needed to judge a skipped preflight -------------
node_ok() {
  local v major minor
  v="$(node -v 2>/dev/null | sed 's/^v//')"
  [ -n "$v" ] || return 1
  major="${v%%.*}"
  minor="${v#*.}"
  minor="${minor%%.*}"
  [ "$major" -ge 24 ] 2>/dev/null || return 1
  if [ "$major" -eq 24 ] && [ "$minor" -lt 9 ]; then return 1; fi
  [ "$major" -lt 27 ] 2>/dev/null || return 1
  return 0
}

# --- stage runner ----------------------------------------------------------------------
stage_names=()
stage_statuses=()
stage_exits=()
stage_commands=()
stage_durations=()
stage_reasons=()
stage_logs=()
failures=0
skips=0
passes=0

# run_stage <name> <command string> <argv...>
run_stage() {
  local name="$1" command="$2"
  shift 2
  local out="$run_dir/.stage-$name.out"
  local started ended duration status code reason=""

  started="$(now_ms)"
  "$@" >"$out" 2>&1
  code=$?
  ended="$(now_ms)"
  duration=$((ended - started))

  printf '\n$ %s\n' "$command" >>"$log_file"
  cat "$out" >>"$log_file"

  if [ "$json_mode" -eq 0 ]; then
    printf '\n$ %s\n' "$command"
    cat "$out"
  fi

  if [ "$code" -eq 0 ]; then
    status="pass"
    passes=$((passes + 1))
  elif [ "$name" = "preflight" ] && [ "$code" -eq 8 ] && [ "$dsh_available" -eq 0 ] && node_ok; then
    # preflight refuses to pass without the harness installed. That is an environment gap,
    # not a code failure: node is in the tested window and every other stage can run.
    status="skipped"
    reason="dsh binary not installed at $dsh_bin; preflight refuses to pass without it (set FACTORY_DSH_BIN to run this stage)"
    skips=$((skips + 1))
  else
    status="fail"
    failures=$((failures + 1))
    reason="$(tail -3 "$out" | tr '\n' ' ' | sed 's/  */ /g' | cut -c1-400)"
  fi

  stage_names+=("$name")
  stage_statuses+=("$status")
  stage_exits+=("$code")
  stage_commands+=("$command")
  stage_durations+=("$duration")
  stage_reasons+=("$reason")
  stage_logs+=("$out")

  # One JSON object per stage. Values are quote-free by construction (fixed command strings,
  # generated names, sanitised reasons), so printf is safe here; the final conversion is done
  # by node, which owns the escaping of the surrounding document.
  local safe_reason="${reason//\"/\'}"
  safe_reason="${safe_reason//\\/}"
  printf '{"name":"%s","command":"%s","exitCode":%d,"status":"%s","durationMs":%d,"reason":"%s"}\n' \
    "$name" "$command" "$code" "$status" "$duration" "$safe_reason" >>"$stages_file"
}

# run_declared_skip <name> <command> <reason-ish> — a row that is skipped without running.
run_declared_skip() {
  local name="$1" command="$2" reason="$3"
  skips=$((skips + 1))
  stage_names+=("$name")
  stage_statuses+=("skipped")
  stage_exits+=("0")
  stage_commands+=("$command")
  stage_durations+=("0")
  stage_reasons+=("$reason")
  stage_logs+=("")
  local safe_reason="${reason//\"/\'}"
  safe_reason="${safe_reason//\\/}"
  printf '{"name":"%s","command":"%s","exitCode":0,"status":"skipped","durationMs":0,"reason":"%s"}\n' \
    "$name" "$command" "$safe_reason" >>"$stages_file"
  printf '\n$ %s\n(skipped) %s\n' "$command" "$reason" >>"$log_file"
  if [ "$json_mode" -eq 0 ]; then printf '\n$ %s\n(skipped) %s\n' "$command" "$reason"; fi
}

# --- the gates, in merge order ----------------------------------------------------------
if ! command -v node >/dev/null 2>&1 || ! command -v pnpm >/dev/null 2>&1; then
  # Fail closed, but still show the row: a harness that cannot run must say so in the table.
  say "verify: FAIL — node and pnpm must both be on PATH (node $node_version, pnpm $pnpm_version)"
  stage_names+=("toolchain")
  stage_statuses+=("fail")
  stage_exits+=("127")
  stage_commands+=("node+pnpm on PATH")
  stage_durations+=("0")
  stage_reasons+=("node or pnpm missing from PATH (node $node_version, pnpm $pnpm_version); no stage could run")
  stage_logs+=("")
  printf '{"name":"toolchain","command":"node+pnpm on PATH","exitCode":127,"status":"fail","durationMs":0,"reason":"node or pnpm missing from PATH (node %s, pnpm %s)"}\n' \
    "$node_version" "$pnpm_version" >>"$stages_file"
  failures=$((failures + 1))
else
  run_stage preflight "bash scripts/preflight.sh" bash scripts/preflight.sh
  run_stage typecheck "pnpm run typecheck" pnpm run typecheck
  run_stage lint "pnpm run lint" pnpm run lint
  run_stage "format:check" "pnpm run format:check" pnpm run format:check
  run_stage test "pnpm exec vitest run" pnpm exec vitest run
  run_stage build "pnpm run build" pnpm run build
fi

# The live stage spends money, so it is OPT-IN even when a key is present: `FACTORY_VERIFY_LIVE=1`
# turns it into a real stage. Before this, the note claimed live calls were "excluded by design (no
# network)" -- true when no live spec existed, false once one did, and a skip message that describes
# a version of the harness that no longer exists is the defect this repo keeps finding.
live_ready=false
if [ "$bifrost_present" = true ] && [ -n "${DSH_BIN:-}" ] && [ -x "${DSH_BIN:-}" ]; then
  live_ready=true
fi
if [ "$live_ready" = true ] && [ "${FACTORY_VERIFY_LIVE:-0}" = "1" ]; then
  run_stage live-model "pnpm run test:live" pnpm run test:live
elif [ "$live_ready" = true ]; then
  run_declared_skip live-model "pnpm run test:live" \
    "BIFROST_API_KEY and DSH_BIN are set; the live stage spends money and is opt-in — set FACTORY_VERIFY_LIVE=1 to run it"
elif [ "$bifrost_present" = true ]; then
  run_declared_skip live-model "pnpm run test:live" \
    "BIFROST_API_KEY is set but DSH_BIN is not — the live specs need the installed dsh binary"
else
  run_declared_skip live-model "pnpm run test:live" \
    "BIFROST_API_KEY is not set; live model tests are not part of offline verification"
fi

# --- table ------------------------------------------------------------------------------
label() {
  case "$1" in
    pass) printf 'PASS   ' ;;
    fail) printf 'FAIL   ' ;;
    skipped) printf 'SKIPPED' ;;
    *) printf '%-7s' "$1" ;;
  esac
}

table() {
  printf '%-13s %-8s %-5s %-9s %s\n' "stage" "status" "exit" "duration" "command"
  printf '%-13s %-8s %-5s %-9s %s\n' "-------------" "--------" "-----" "---------" "-------"
  local i
  for i in "${!stage_names[@]}"; do
    printf '%-13s %s %-5s %-9s %s\n' \
      "${stage_names[$i]}" "$(label "${stage_statuses[$i]}")" "${stage_exits[$i]}" \
      "$(awk -v ms="${stage_durations[$i]}" 'BEGIN { printf "%.2fs", ms / 1000 }')" \
      "${stage_commands[$i]}"
    if [ -n "${stage_reasons[$i]}" ] && [ "${stage_statuses[$i]}" != "pass" ]; then
      printf '%-13s   └─ %s\n' "" "${stage_reasons[$i]}"
    fi
  done
}

say ""
say "verify: results"
say ""
table | while IFS= read -r line; do say "$line"; done

overall=0
if [ "$failures" -gt 0 ]; then overall=1; fi
say ""
say "verify: $passes passed, $skips skipped, $failures failed — $([ "$overall" -eq 0 ] && printf 'OK' || printf 'NOT OK')"
if [ "$overall" -ne 0 ]; then
  failed_names=""
  for i in "${!stage_names[@]}"; do
    if [ "${stage_statuses[$i]}" = "fail" ]; then failed_names="$failed_names ${stage_names[$i]}"; fi
  done
  say "verify: failed stages:$failed_names"
fi
say "verify: log $log_file"

# --- summary.json -----------------------------------------------------------------------
VERIFY_RUN_DIR="$run_dir" VERIFY_LOG="$log_file" VERIFY_SUMMARY="$summary_file" \
  VERIFY_STAGES="$stages_file" VERIFY_JSON_MODE="$json_mode" VERIFY_STAMP="$stamp" \
  VERIFY_ROOT="$ROOT" VERIFY_NODE="$node_version" VERIFY_PNPM="$pnpm_version" \
  VERIFY_BRANCH="$git_branch" VERIFY_HEAD="$git_head" VERIFY_DIRTY="$git_dirty" \
  VERIFY_DSH_AVAILABLE="$dsh_available" VERIFY_DSH_BIN="$dsh_bin" VERIFY_DSH_VERSION="$dsh_version" \
  VERIFY_BIFROST="$bifrost_present" VERIFY_DEEPSEEK="$deepseek_present" \
  VERIFY_PASSES="$passes" VERIFY_SKIPS="$skips" VERIFY_FAILURES="$failures" VERIFY_OVERALL="$overall" \
  node --input-type=module -e '
    import { readFileSync, writeFileSync } from "node:fs";

    const env = process.env;
    const stages = readFileSync(env.VERIFY_STAGES, "utf8")
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line))
      .map((stage) => ({
        name: stage.name,
        command: stage.command,
        status: stage.status,
        exitCode: stage.exitCode,
        durationMs: stage.durationMs,
        reason: stage.reason === "" ? null : stage.reason,
      }));

    const summary = {
      schema: "verify/1",
      plan: "dark-factory-dsh",
      runId: env.VERIFY_STAMP,
      startedAt: env.VERIFY_STAMP,
      ok: env.VERIFY_OVERALL === "0",
      counts: {
        pass: Number(env.VERIFY_PASSES),
        skip: Number(env.VERIFY_SKIPS),
        fail: Number(env.VERIFY_FAILURES),
      },
      environment: {
        node: env.VERIFY_NODE,
        pnpm: env.VERIFY_PNPM,
        git: {
          branch: env.VERIFY_BRANCH,
          head: env.VERIFY_HEAD,
          dirtyPaths: Number(env.VERIFY_DIRTY),
        },
        dsh: {
          available: env.VERIFY_DSH_AVAILABLE === "1",
          path: env.VERIFY_DSH_BIN,
          version: env.VERIFY_DSH_VERSION === "" ? null : env.VERIFY_DSH_VERSION,
        },
        modelKeys: {
          BIFROST_API_KEY: env.VERIFY_BIFROST === "true",
          DEEPSEEK_API_KEY: env.VERIFY_DEEPSEEK === "true",
        },
      },
      stages,
      // phase-11-plan: a skipped test is unknown, never a pass.
      unknowns: stages
        .filter((stage) => stage.status === "skipped")
        .map((stage) => ({ stage: stage.name, reason: stage.reason })),
      artifacts: {
        log: env.VERIFY_LOG,
        summary: env.VERIFY_SUMMARY,
      },
    };

    writeFileSync(env.VERIFY_SUMMARY, JSON.stringify(summary, null, 2) + "\n");
    if (env.VERIFY_JSON_MODE === "1") process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
  '

if [ "$json_mode" -eq 1 ]; then
  # stdout carried the JSON above and nothing else; point the operator at the log on stderr.
  printf 'verify: %s\n' "$log_file" >&2
fi

# Keep per-stage capture files out of the delivered directory; the log has all of it.
rm -f "$run_dir"/.stage-*.out "$stages_file"

exit "$overall"
