/**
 * `factory ledger` — the off-host anchor (ND4, ratified 2026-11-01).
 *
 * The ledger is append-only *inside a file this host controls*. The anchor is the smallest thing that
 * makes a rewrite detectable: once a day, `{seq, headHash, eventCount, anchoredAt}` goes somewhere the
 * factory does not own, and every reader refuses to call the ledger anchored until a fresh record
 * exists.
 *
 * Two subcommands, and the asymmetry between them is the design:
 *
 * - `anchor` writes a record. It is the only thing here that talks to another machine, and it is a
 *   command the *composition root* read from configuration — never a path from a unit's spec.
 * - `verify` reads the record and answers `fresh | stale | missing | rollback`. `rollback` is the one
 *   that matters: an anchor that says the ledger had 400 events next to a database holding 380 is a
 *   restored file, and calling that "fresh" because the timestamp is recent would be the exact failure
 *   the anchor exists to catch.
 *
 * Exit codes: 0 when the anchor is `fresh`; 9 (`integrity`) for `stale`, `missing` or `rollback`; 8
 * (`environment`) when no anchor target is configured or the transport fails. A `local` anchor is
 * reported as such and never described as off-host.
 */
import {
  anchorTargetFrom,
  computeAnchor,
  DEFAULT_MAX_AGE_HOURS,
  shortHash,
  verifyAnchor,
  type AnchorRecord,
  type AnchorTransport,
} from '@factory/anchor';
import { FactoryError } from '@factory/contracts';

import { EXIT, UsageError } from '../exit.ts';
import { field } from '../render/format.ts';
import { numberOption, textOption, type VerbInput, type VerbSpec } from './types.ts';

/**
 * The anchor transport, from the operator's environment. Reading `process.env` here is deliberate:
 * this is a composition decision, and the discipline lint allows env reads at composition roots only.
 *
 * The mapping itself lives in `@factory/anchor` (`anchorTargetFrom`) because `factory alerts` must
 * read the same configuration the same way: a monitor that built its own transport could watch a
 * different anchor than the control it reports on, and neither surface would look wrong on its own.
 * The only thing this verb adds is its own `--dir` override.
 *
 * - `FACTORY_ANCHOR_SSH=host` → `ssh host 'tail …'` / `ssh host 'cat >> …'` (`FACTORY_ANCHOR_PATH`)
 * - `FACTORY_ANCHOR_DIR=dir`  → a local directory, reported as **local**, never as off-host
 * - neither                  → refuse, naming both variables (`ANCHOR_UNAVAILABLE`, exit 8)
 */
function transportFrom(
  env: Readonly<Record<string, string | undefined>>,
  options: Readonly<Record<string, unknown>>,
): AnchorTransport {
  return anchorTargetFrom(env, { directory: textOption(options, 'dir') }).transport;
}

/** The events the anchor hashes: the whole ledger, in order, as the ledger itself reports it. */
function ledgerEvents(ctx: VerbInput['ctx']): readonly unknown[] {
  const events: unknown[] = [];
  let cursor = 0;
  for (;;) {
    const page = ctx.store.eventsSince(cursor, 1000);
    if (page.length === 0) return events;
    events.push(...page);
    const last = page[page.length - 1];
    cursor = last === undefined ? cursor : last.seq;
    if (page.length < 1000) return events;
  }
}

export async function runLedger(input: VerbInput): Promise<number> {
  const action = input.args[0] ?? 'verify';
  if (action !== 'anchor' && action !== 'verify') {
    throw new UsageError(`USAGE: factory ledger <anchor|verify>; got ${JSON.stringify(action)}`);
  }
  const transport = transportFrom(input.ctx.env, input.options);

  if (action === 'anchor') {
    const events = ledgerEvents(input.ctx);
    const record = computeAnchor(events, input.ctx.nowIso());
    await transport.append(record);
    input.emit({
      action: 'anchor',
      transport: transport.describe(),
      scope: transport.scope,
      record,
    });
    // Human lines go to stderr when `--json` owns stdout, so `--json` stays exactly one object.
    input.ctx.ui.err(
      [
        field('anchored', `${String(record.eventCount)} events, seq ${String(record.seq)}`),
        field('head', shortHash(record.headHash)),
        field('where', transport.describe()),
        field('scope', transport.scope === 'off-host' ? 'off-host' : 'LOCAL (not off-host)'),
      ].join('\n'),
    );
    return EXIT.ok;
  }

  const record = await transport.readHead();
  const verdict = verifyAnchor(record, {
    nowIso: input.ctx.nowIso(),
    maxAgeHours:
      textOption(input.options, 'maxAgeHours') === undefined
        ? DEFAULT_MAX_AGE_HOURS
        : numberOption(input.options, 'maxAgeHours', 'e.g. --max-age-hours 48'),
    scope: transport.scope,
    local: { seq: input.ctx.store.eventCount(), eventCount: input.ctx.store.eventCount() },
  });
  input.emit({
    action: 'verify',
    transport: transport.describe(),
    scope: transport.scope,
    outcome: verdict.outcome,
    offHost: verdict.offHost,
    ageHours: verdict.ageHours,
    reason: verdict.reason,
    record: verdict.record,
  });
  input.ctx.ui.err(
    [
      field('outcome', verdict.outcome.toUpperCase()),
      field('age', verdict.ageHours === null ? 'n/a' : `${verdict.ageHours.toFixed(1)} h`),
      field('scope', verdict.offHost ? 'off-host' : 'LOCAL (not off-host)'),
      field('reason', verdict.reason),
    ].join('\n'),
  );
  if (verdict.outcome !== 'fresh') return EXIT.integrity;
  return EXIT.ok;
}

export const ledgerVerb: VerbSpec = {
  name: 'ledger',
  verb: 'ledger',
  summary: 'Anchor the ledger head off-host, or verify the anchor is still fresh',
  arguments: ['[action]'],
  configure: (command) =>
    command
      .option('--dir <path>', 'anchor into this local directory instead of the configured target')
      .option('--max-age-hours <n>', 'how old an anchor may be and still count as fresh'),
  action: runLedger,
};

/** Exported for the spec: the record shape a verifier must accept, nothing else. */
export type { AnchorRecord };
