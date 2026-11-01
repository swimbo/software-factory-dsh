#!/usr/bin/env bash
# provision-dsh-home.sh — one-time, idempotent setup of the factory's DSH homes.
#
# Creates `$FACTORY_HOME/dsh-home/{worker,evaluator}`, each with its own custom
# `factory-worker` profile initialised from the shipped `headless` template, and
# asserts the result contains no operator home layer, no MCP server and no
# third-party plugin.
#
# Why one home per trust domain: DSH composes `$DSH_HOME/cordis.patch.yml` into
# *every* profile, so a worker sharing the operator's home would inherit the
# operator's MCP servers and personal model credentials (research D5, Phase-5
# observation). Separate homes are what keep the wall's credentials out of the
# worker's reach even if the worker escapes its own sandbox.
#
# Why `--dump-config`: the phase plan's literal command,
#
#     dsh --profile factory-worker --from-default-profile headless
#
# creates the profile *and then boots the headless app*, which exits 1 with
# `dsh: a task is required`. Under `set -e` that fails provisioning on the first
# run — after the profile was created, so the retry fails too and the state is
# confusing. Adding `--dump-config` composes and prints the profile instead of
# booting it: same profile, exit 0, and provably no chance of starting a turn (and
# therefore no chance of a paid model call). Verified against 0.2.1-rc.5.
#
# Usage:
#   scripts/provision-dsh-home.sh [--root DIR] [--dsh PATH] [--profile NAME]
#                                 [--expect-version VER] [--force]
#
# Prints the exact DSH_HOME values for the runbooks on stdout, and nothing else,
# so it can be sourced by a setup script.

set -euo pipefail

readonly DEFAULT_VERSION='0.2.1-rc.5'
readonly DOMAINS=(worker evaluator)

log() { printf '%s\n' "provision-dsh-home: $*" >&2; }
die() { printf '%s\n' "provision-dsh-home: error: $*" >&2; exit 1; }

ROOT="${FACTORY_HOME:-$HOME/.factory}"
DSH_BIN="${FACTORY_DSH_BIN:-}"
PROFILE='factory-worker'
EXPECT_VERSION="$DEFAULT_VERSION"
FORCE=0

while [ $# -gt 0 ]; do
  case "$1" in
    --root) ROOT="${2:?--root needs a directory}"; shift 2 ;;
    --dsh) DSH_BIN="${2:?--dsh needs a path}"; shift 2 ;;
    --profile) PROFILE="${2:?--profile needs a name}"; shift 2 ;;
    --expect-version) EXPECT_VERSION="${2:?--expect-version needs a version}"; shift 2 ;;
    --force) FORCE=1; shift ;;
    -h|--help) sed -n '2,40p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done

# Resolve the binary: explicit flag, then PATH, then the macOS bundle, which is
# where the desktop app installs it and the one path it never puts on PATH.
if [ -z "$DSH_BIN" ]; then
  if command -v dsh >/dev/null 2>&1; then
    DSH_BIN="$(command -v dsh)"
  elif [ -x '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh' ]; then
    DSH_BIN='/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh'
  else
    die 'cannot find dsh; pass --dsh PATH or set FACTORY_DSH_BIN'
  fi
fi
[ -x "$DSH_BIN" ] || die "dsh is not executable: $DSH_BIN"

ACTUAL_VERSION="$("$DSH_BIN" --version 2>/dev/null | tr -d '\r')"
[ -n "$ACTUAL_VERSION" ] || die "cannot read the dsh version from $DSH_BIN"
if [ "$ACTUAL_VERSION" != "$EXPECT_VERSION" ]; then
  # The profile schema, the --json event shapes and the five required overlay
  # entries are all version-specific. Provisioning a home for an unverified build
  # would produce receipts from a contract nobody tested.
  die "dsh is $ACTUAL_VERSION, this script is pinned to $EXPECT_VERSION"
fi
log "dsh $ACTUAL_VERSION at $DSH_BIN"

# Guard the root before anything is created under it. `--force` deletes profile
# directories, and a mistyped `--root` must not be able to do that to the
# operator's home, the filesystem root, or a source checkout.
case "$ROOT" in
  / | "" | .) die "refusing to provision into $(printf '%q' "$ROOT")" ;;
esac
[ "${#ROOT}" -ge 8 ] || die "refusing to provision into an implausibly short root: $ROOT"
if [ -d "$ROOT/.git" ] || [ -f "$ROOT/package.json" ]; then
  die "refusing to provision into a source checkout: $ROOT"
fi
[ -w "$(dirname "$ROOT")" ] || die "the parent of $ROOT is not writable: $(dirname "$ROOT")"

mkdir -p "$ROOT/dsh-home"

# Assert one already-created profile really is pristine. A profile with extra
# bundles or a non-empty patch layer is the failure this script exists to prevent,
# and it is silent unless checked.
assert_pristine() {
  local home="$1"
  local profile_dir="$home/profiles/$PROFILE"

  [ -d "$profile_dir" ] || die "profile was not created: $profile_dir"
  [ -f "$profile_dir/package.json" ] || die "profile has no package.json: $profile_dir"

  # Bundles must be exactly base + headless: no MCP, no third-party plugin.
  #
  # Parsed with `node`, not `python3`: node is a hard dependency of this repo (and
  # of DSH), while python3 is not installed on a minimal worker host or in
  # `docker/factory-env`. A provisioning script that only runs on the operator's
  # laptop is not a provisioning script.
  local bundles
  bundles="$(node -e '
    const data = require(process.argv[1]);
    const bundles = data?.dsh?.profile?.bundles ?? [];
    process.stdout.write(bundles.join(","));
  ' "$profile_dir/package.json")"
  if [ "$bundles" != '@deepseek-ai/dsh-base,@deepseek-ai/dsh-headless' ]; then
    die "profile bundles are not the shipped pair: $bundles"
  fi

  # The profile patch layer must be empty: this script writes no home-layer or
  # profile-layer plugin, so anything here came from somewhere else.
  local patch_layer="$profile_dir/cordis.patch.yml"
  [ -f "$patch_layer" ] || die "profile has no patch layer: $patch_layer"
  if grep -qvE '^[[:space:]]*(#|\[\][[:space:]]*$)' "$patch_layer"; then
    die "profile patch layer is not empty: $patch_layer"
  fi

  # The home layer is composed into every profile; its absence is the isolation
  # guarantee. Never create it, and refuse to bless a home that has one.
  if [ -e "$home/cordis.patch.yml" ]; then
    die "home patch layer exists and would leak into every profile: $home/cordis.patch.yml"
  fi
}

for domain in "${DOMAINS[@]}"; do
  home="$ROOT/dsh-home/$domain"
  mkdir -p "$home"
  profile_dir="$home/profiles/$PROFILE"

  if [ -d "$profile_dir" ] && [ "$FORCE" -eq 0 ]; then
    log "$domain: profile $PROFILE already exists, leaving it alone"
  else
    if [ -d "$profile_dir" ]; then
      log "$domain: --force given, recreating profile $PROFILE"
      rm -rf "$profile_dir"
    fi
    log "$domain: initialising profile $PROFILE from the headless template"
    # `--dump-config` composes and exits. Without it DSH boots the app and exits 1
    # with "a task is required" — see the header.
    if ! DSH_HOME="$home" DSH_TELEMETRY_DISABLED=1 \
        "$DSH_BIN" --profile "$PROFILE" --from-default-profile headless --dump-config \
        >/dev/null 2>"$home/.provision.log"; then
      die "profile initialisation failed for $domain; see $home/.provision.log"
    fi
    rm -f "$home/.provision.log"
  fi

  assert_pristine "$home"
  log "$domain: ok"
done

# Machine-readable, and the only thing on stdout: the runbooks quote these.
printf 'DSH_HOME_WORKER=%s\n' "$ROOT/dsh-home/worker"
printf 'DSH_HOME_EVALUATOR=%s\n' "$ROOT/dsh-home/evaluator"
log 'done'
