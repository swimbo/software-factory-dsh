#!/usr/bin/env node
/**
 * The operator CLI, wired.
 *
 * `main.ts` owns exactly four things, and every verb inherits them:
 *
 * 1. **commander**, with `--json`/`--plain`/`--no-color` and a `LIMITS` section
 *    appended to every verb's `--help` (`ux-plan.md` §7, "bait and switch").
 * 2. **the error funnel**: a `FactoryError` maps to its documented exit code via
 *    `exitCodeFor`; a usage problem maps to 2; anything else is `INTERNAL` (1)
 *    with the traceId printed, because an unexpected failure without an id is not
 *    something an operator can report.
 * 3. **the `--json` contract**: exactly one object on stdout, ever —
 *    `{"ok":true,…}` or `{"ok":false,"code","message","exitCode",…}` — and all
 *    human text on stderr (§3, §8).
 * 4. **the bypass refusal**, before commander parses anything, so `-y` cannot be
 *    accidentally accepted by a future option definition (§7 A-3).
 */
import { Command, CommanderError } from 'commander';
import { pathToFileURL } from 'node:url';

import { createUi, withContextAsync, type CliContextOverrides, type CliUi } from './context.ts';
import {
  classify,
  EXIT,
  newTraceIdForCli,
  refuseBypassFlags,
  UsageError,
  type FailureReport,
} from './exit.ts';
import { limitsFor } from './render/limits.ts';
import { abortVerb } from './verbs/abort.ts';
import { auditVerb } from './verbs/audit.ts';
import { budgetVerb } from './verbs/budget.ts';
import { credentialVerb } from './verbs/credential.ts';
import { intentVerb } from './verbs/intent.ts';
import { promoteVerb } from './verbs/promote.ts';
import { qualifyVerb } from './verbs/qualify.ts';
import { receiptsVerb } from './verbs/receipts.ts';
import { recoverVerb } from './verbs/recover.ts';
import { runVerb } from './verbs/run.ts';
import { statusVerb } from './verbs/status.ts';
import { versionVerb, FACTORY_VERSION, PINNED_DSH_VERSION } from './verbs/version.ts';
import type { VerbSpec } from './verbs/types.ts';

export const VERB_SPECS: readonly VerbSpec[] = [
  intentVerb,
  qualifyVerb,
  runVerb,
  statusVerb,
  receiptsVerb,
  auditVerb,
  recoverVerb,
  abortVerb,
  promoteVerb,
  budgetVerb,
  credentialVerb,
  versionVerb,
];

export interface MainOptions {
  readonly argv?: readonly string[];
  readonly ui?: CliUi;
  readonly overrides?: CliContextOverrides;
}

/** Global flags are read before commander parses, so even a usage error renders correctly. */
function scanGlobals(argv: readonly string[]): { json: boolean; plain: boolean; noColor: boolean } {
  return {
    json: argv.includes('--json'),
    plain: argv.includes('--plain'),
    noColor: argv.includes('--no-color'),
  };
}

function buildProgram(ui: CliUi, overrides: CliContextOverrides): Command {
  const program = new Command();
  program
    .name('factory')
    .description(
      'The dark software factory: intent in, a wall verdict out. Deterministic, no model calls,\n' +
        'no network. Every gate needs a typed phrase; there is no -y.',
    )
    .version(FACTORY_VERSION, '-v, --version')
    .option('--json', 'print exactly one JSON object on stdout')
    .option('--plain', 'zero ANSI bytes of any kind: no colour, no bold, no glyphs, no spinners')
    .option('--no-color', 'colour off (NO_COLOR is also honoured)')
    .exitOverride();

  program.addHelpText(
    'after',
    [
      '',
      `dsh version this build pins: ${PINNED_DSH_VERSION}`,
      'Exit codes: 0 ok · 1 internal · 2 usage · 3 policy · 4 unknown/ambiguous · 5 gate ·',
      '            6 budget · 7 conflict · 8 environment · 9 integrity',
      'No gate can be bypassed: -y, --yes, --force, -f and --assume-yes are usage errors (exit 2).',
    ].join('\n'),
  );

  for (const spec of VERB_SPECS) {
    const command = program.command(spec.name).description(spec.summary);
    for (const argument of spec.arguments ?? []) command.argument(argument);
    spec.configure(command);
    command.addHelpText('after', limitsFor(spec.verb));
    command.exitOverride();
    command.action(async (...raw: unknown[]) => {
      lastExit = await executeCommand(spec, ui, overrides, raw);
    });
  }
  return program;
}

let lastExit: number = EXIT.ok;

async function executeCommand(
  spec: VerbSpec,
  ui: CliUi,
  overrides: CliContextOverrides,
  raw: readonly unknown[],
): Promise<number> {
  const command = raw[raw.length - 1] as Command;
  // Commander passes `undefined` for an omitted optional argument; `String()` on it
  // would send the literal text "undefined" to the verb as a unit id.
  const positional = raw
    .slice(0, Math.max(raw.length - 2, 0))
    .filter((value) => value !== undefined && value !== null)
    .map((value) => String(value));
  const options: Record<string, unknown> = {
    ...((raw.length >= 2 ? raw[raw.length - 2] : {}) as Record<string, unknown>),
    ...command.opts(),
  };

  let emitted = false;
  const emit = (payload: object): void => {
    if (!ui.json) return;
    if (emitted) {
      throw new UsageError(
        'internal: a verb tried to print two JSON objects; the --json contract is one',
      );
    }
    emitted = true;
    ui.out(JSON.stringify({ ok: true, ...payload }));
  };

  // `--cold-start` is a per-invocation policy switch, so it has to be decided
  // before the context (and the engine's qualifier closure) is built.
  const invocationOverrides: CliContextOverrides =
    options['coldStart'] === true ? { ...overrides, allowColdStart: true } : overrides;

  try {
    return await withContextAsync(ui, invocationOverrides, async (ctx) =>
      spec.action({ ctx, args: positional, options, emit }),
    );
  } catch (error) {
    const report = classify(error, overrides.traceId ?? newTraceIdForCli());
    renderFailure(report, ui);
    return report.exitCode;
  }
}

/** The five-part message of §5.2, rendered once so every verb's failures look the same. */
export function renderFailure(report: FailureReport, ui: CliUi): void {
  if (ui.json) {
    ui.out(
      JSON.stringify({
        ok: false,
        code: report.code,
        message: report.message,
        exitCode: report.exitCode,
        traceId: report.traceId,
      }),
    );
  }
  const message = report.message.startsWith(`${report.code}:`)
    ? report.message
    : `${report.code}: ${report.message}`;
  for (const line of message.split('\n')) ui.err(line);
  ui.err(`traceId ${report.traceId}`);
  if (report.runbook !== null) ui.err(`  ${report.runbook}`);
}

export async function main(options: MainOptions = {}): Promise<number> {
  const argv = options.argv ?? process.argv.slice(2);
  const globals = scanGlobals(argv);
  const ui =
    options.ui ??
    createUi({
      json: globals.json,
      plain: globals.plain,
      ...(globals.noColor ? { color: false } : {}),
    });
  const overrides: CliContextOverrides = {
    traceId: options.overrides?.traceId ?? newTraceIdForCli(),
    ...(options.overrides ?? {}),
  };
  lastExit = EXIT.ok;

  try {
    refuseBypassFlags(argv);
  } catch (error) {
    const report = classify(error, overrides.traceId ?? newTraceIdForCli());
    renderFailure(report, ui);
    return report.exitCode;
  }

  const program = buildProgram(ui, overrides);
  try {
    await program.parseAsync([...argv], { from: 'user' });
    return lastExit;
  } catch (error) {
    if (error instanceof CommanderError) {
      // `--help` and `--version` are successful commands, not failures.
      if (
        error.code === 'commander.helpDisplayed' ||
        error.code === 'commander.version' ||
        error.code === 'commander.help'
      ) {
        return error.exitCode === 0 ? EXIT.ok : EXIT.usage;
      }
      const report: FailureReport = {
        code: 'USAGE',
        exitCode: EXIT.usage,
        message: `${error.message}. Run: factory --help`,
        traceId: overrides.traceId ?? newTraceIdForCli(),
        runbook: null,
      };
      renderFailure(report, ui);
      return report.exitCode;
    }
    const report = classify(error, overrides.traceId ?? newTraceIdForCli());
    renderFailure(report, ui);
    return report.exitCode;
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  void main().then((code) => {
    // `process.exitCode` rather than `process.exit()`, so a piped stdout is not
    // truncated mid-write (E2E-30 asserts no partial line survives a kill).
    process.exitCode = code;
  });
}
