/**
 * `factory gate`'s shared machinery.
 *
 * Three jobs, and all three are "verify, never sign":
 *
 * 1. **Where a decision lives.** `FACTORY_HOME/gates/<decisionId>.json` is the artifact a person
 *    reads without a database; the `privileged.decided` ledger event is the same fact an audit
 *    replays. `decide` writes both; `request`/`list`/`show` read the artifact only, so a read-only
 *    verb cannot move the ledger.
 * 2. **The operator key.** The lookup order (`FACTORY_OPERATOR_KEY`, then
 *    `$FACTORY_HOME/keys/operator.pub.pem`, then `operator.ed25519.pub`) is `factory promote`'s,
 *    because an operator with one key pair should not have to remember which verb reads which
 *    file — and because rotation means "replace the file", so this list is also the retirement
 *    story: a key that is no longer in it no longer verifies anything.
 * 3. **The one-use ports.** `storeDecisionPorts` turns the store's atomic marker insert into the
 *    `DecisionRegistry` the broker takes, which is what makes "a decision is not a session" true
 *    across processes rather than within one `broker` call.
 *
 * Nothing in this file holds, derives or writes a private key, and no function here can mint a
 * signature. The tool verifies the operator's; it never makes one.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { contentHash } from '@factory/contracts';
import { keyId } from '@factory/gates';
import {
  DecisionError,
  decisionPayload,
  gatePhraseOf,
  parseDecision,
  toArtifact,
} from '../../../packages/proxy/src/index.ts';
import type {
  DecisionRegistry,
  DecisionSink,
  PrivilegedDecision,
} from '../../../packages/proxy/src/index.ts';
import type { AppendOptions, Store } from '@factory/store';

/** The decision artifacts live under `FACTORY_HOME/gates/`, beside `keys/` and `state/`. */
export const GATE_DIR_NAME = 'gates';

/** The default window an operator's decision stays live: long enough for a run, short enough to mean. */
export const DEFAULT_DECISION_TTL_MS = 15 * 60_000;

export function gateDir(home: string): string {
  return join(home, GATE_DIR_NAME);
}

export function gateArtifactPath(home: string, decisionId: string): string {
  return join(gateDir(home), `${decisionId}.json`);
}

/**
 * `15m`, `30s`, `2h`, `500ms` → milliseconds, or `null` for anything that is not a positive
 * duration with a unit. A bare number is refused rather than guessed at: `--expires-in 15` would
 * otherwise be either fifteen seconds or fifteen minutes depending on who wrote the parser.
 */
export function parseDuration(text: string): number | null {
  const match = /^(\d+)(ms|s|m|h)$/u.exec(text.trim());
  if (match === null) return null;
  const amount = Number(match[1]);
  const unit = match[2];
  const factor = unit === 'ms' ? 1 : unit === 's' ? 1_000 : unit === 'm' ? 60_000 : 3_600_000;
  const ms = amount * factor;
  return Number.isFinite(ms) && ms > 0 ? ms : null;
}

/** `iso + ms`, as the ISO-8601 UTC string `decision.ts` accepts. */
export function addMs(iso: string, ms: number): string {
  return new Date(Date.parse(iso) + ms).toISOString();
}

/** The phrase the operator types: fixed by the operation, so it can be reconstructed from a record. */
export function gatePhrase(operationSha: string): string {
  return gatePhraseOf(operationSha);
}

/**
 * The `taskId` a standalone gate decision carries: `gate:<8 hex>`.
 *
 * A standalone operation has no unit, and inventing a unit id would be a false claim about what the
 * operator was looking at. This is a *label for reading*, derived from the operation hash, and the
 * runbook says so; it is never treated as a unit that exists.
 */
export function gateTaskId(operationSha: string): string {
  return `gate:${operationSha.slice('sha256:'.length, 'sha256:'.length + 8)}`;
}

/** Every operator public key this factory accepts a decision from, `keyId → pem`. */
export function activeOperatorKeys(
  env: Readonly<Record<string, string | undefined>>,
  paths: { readonly keys: string },
): Map<string, string> {
  const active = new Map<string, string>();
  for (const pem of operatorPublicKeyPems(env, paths)) {
    try {
      active.set(keyId(pem), pem);
    } catch {
      // A file that is not a parsable public key is not a key. Skipping it here means it cannot
      // verify anything, which is the fail-closed direction; `request` prints the problem instead.
    }
  }
  return active;
}

/** The same lookup order `factory promote` uses; every file that exists and parses. */
export function operatorPublicKeyPems(
  env: Readonly<Record<string, string | undefined>>,
  paths: { readonly keys: string },
): readonly string[] {
  const configured = (env['FACTORY_OPERATOR_KEY'] ?? '').trim();
  const candidates = [
    ...(configured === '' ? [] : [configured]),
    join(paths.keys, 'operator.pub.pem'),
    join(paths.keys, 'operator.ed25519.pub'),
  ];
  const pems: string[] = [];
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    try {
      const text = readFileSync(candidate, 'utf8').trim();
      if (text.length > 0 && !pems.includes(text)) pems.push(text);
    } catch {
      // An unreadable file is reported by its absence, not by throwing from a status command.
    }
  }
  return pems;
}

export interface LoadedDecisions {
  readonly decisions: readonly PrivilegedDecision[];
  /** Artifacts that exist but are not usable records: edits, half-writes, or a typo. */
  readonly problems: readonly { readonly path: string; readonly detail: string }[];
}

/**
 * Read every artifact under `FACTORY_HOME/gates/`.
 *
 * The artifact deliberately omits the phrase (only `phraseSha` is written), so the phrase is
 * reconstructed from the operation it binds — `decide <sha8>` — and the reconstruction is checked
 * against `phraseSha` before the record is believed. A record whose phrase was not the canonical
 * one therefore fails here, by hash, rather than by a rule someone has to remember.
 */
export function loadDecisions(home: string): LoadedDecisions {
  const dir = gateDir(home);
  if (!existsSync(dir)) return { decisions: [], problems: [] };
  const decisions: PrivilegedDecision[] = [];
  const problems: { path: string; detail: string }[] = [];
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith('.json')) continue;
    const path = join(dir, name);
    try {
      decisions.push(decisionFromArtifact(JSON.parse(readFileSync(path, 'utf8'))));
    } catch (error) {
      problems.push({ path, detail: error instanceof Error ? error.message : String(error) });
    }
  }
  return { decisions, problems };
}

/** Rebuild the record from an artifact, with the phrase recovered from its signed operation hash. */
export function decisionFromArtifact(raw: unknown): PrivilegedDecision {
  if (raw === null || typeof raw !== 'object') {
    throw new DecisionError('a decision artifact must be a JSON object');
  }
  const body = raw as Record<string, unknown>;
  const operationSha = body['operationSha'];
  if (typeof operationSha !== 'string') {
    throw new DecisionError("a decision artifact needs a string 'operationSha'");
  }
  const phrase = gatePhrase(operationSha);
  const phraseSha = body['phraseSha'];
  if (typeof phraseSha !== 'string' || contentHash({ phrase }) !== phraseSha) {
    throw new DecisionError(
      `the artifact does not carry the canonical phrase for ${operationSha} (its phraseSha does not ` +
        'match "decide <sha8>"); a decision whose phrase cannot be recovered cannot be re-verified',
    );
  }
  const decision = parseDecision({ ...body, phrase });
  // `payloadSha` is the artifact's own claim about what was signed; recomputing it here means a
  // hand-edited field is caught even when the edit happens to preserve the derived id's shape.
  const payloadSha = body['payloadSha'];
  if (typeof payloadSha === 'string' && payloadSha !== decisionPayload(decision)) {
    throw new DecisionError(
      `artifact ${decision.decisionId} records payloadSha ${payloadSha}, but its content hashes to ` +
        `${decisionPayload(decision)}; the record was edited after it was signed`,
    );
  }
  return decision;
}

/** Write the readable half of the record. Returns the path so a verb can print it. */
export function writeDecisionArtifact(home: string, decision: PrivilegedDecision): string {
  const dir = gateDir(home);
  mkdirSync(dir, { recursive: true });
  const path = gateArtifactPath(home, decision.decisionId);
  writeFileSync(path, `${JSON.stringify(toArtifact(decision), null, 2)}\n`);
  return path;
}

/**
 * The broker's one-use ports, backed by the store.
 *
 * `consume` is the whole enforcement: one conditional `INSERT … ON CONFLICT DO NOTHING` that
 * returns whether this caller created the marker. The sink is a real object with a deliberately
 * empty `append`: the decision's `privileged.decided` event was written once, when the decision was
 * minted (`factory gate decide`), and `consume` writes the separate consumption marker atomically.
 * A second event for the same decision would read as a second decision, which is the opposite of
 * what this port is for.
 */
export function storeDecisionPorts(
  store: Store,
  options: AppendOptions,
): { readonly registry: DecisionRegistry; readonly sink: DecisionSink } {
  return {
    registry: {
      isConsumed: (decisionId) => store.isDecisionConsumed(decisionId),
      consume: (decision, at) =>
        store.recordDecisionConsumed(decision.decisionId, { ...options, occurredAt: at }),
    },
    sink: {
      append: () => undefined,
    },
  };
}
