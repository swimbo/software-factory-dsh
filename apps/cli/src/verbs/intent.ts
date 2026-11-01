/**
 * `factory intent` — submit a unit, and bind its restate-back.
 *
 * The flow (`ux-plan.md` §3.1) prints ids, the acceptance table and the blast
 * radius on **stderr**, and nothing on stdout without `--json`: a submission
 * produces no data payload the shell needs. Two refusals matter:
 *
 * - `SPEC_INVALID` (exit 3) names the file, line, column and the exact schema
 *   path, because "invalid spec" without a path is a message that makes the
 *   operator re-read a 40-line file to find one wrong word.
 * - `DUPLICATE_UNIT` (exit 3) fires when the same slug+revision carries a
 *   *different* hash: the intent changed, so it is a new unit colliding with an
 *   old key, and the fix is `spec.revision`, not an overwrite.
 *
 * Re-submitting the identical spec is, by contrast, an idempotent success that
 * says "existing" and creates nothing (§3.1, and the engine returns
 * `created: false` for exactly this case).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { contentHash, FactoryError, UnitSpec } from '@factory/contracts';

import { UsageError } from '../exit.ts';
import { field, record, wrap } from '../render/format.ts';
import { requiredOption, textOption, type VerbInput, type VerbSpec } from './types.ts';

/** Turn a zod issue path into the syntax an operator would type: `acceptance[1].oracle.kind`. */
function formatPath(path: ReadonlyArray<PropertyKey>): string {
  let out = '';
  for (const segment of path) {
    if (typeof segment === 'number') {
      out += `[${segment}]`;
      continue;
    }
    out += out === '' ? String(segment) : `.${String(segment)}`;
  }
  return out === '' ? '<root>' : out;
}

/** Best-effort line/column of the first occurrence of the leaf key, so the message points at a line. */
function locate(
  source: string,
  path: ReadonlyArray<PropertyKey>,
): { line: number; column: number } {
  const leaf = [...path].reverse().find((segment) => typeof segment === 'string');
  if (leaf === undefined) return { line: 1, column: 1 };
  const needle = `"${String(leaf)}"`;
  const index = source.indexOf(needle);
  if (index < 0) return { line: 1, column: 1 };
  const before = source.slice(0, index);
  const line = before.split('\n').length;
  const column = index - (before.lastIndexOf('\n') + 1) + 1;
  return { line, column };
}

function readSpec(file: string, raw: string): UnitSpec {
  const absolute = resolve(file);
  const text = (() => {
    try {
      return readFileSync(absolute, 'utf8');
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new FactoryError(
        'SPEC_INVALID',
        `SPEC_INVALID: ${file}:1:1 <file>: expected a readable JSON spec; got ${detail}`,
        {
          file,
        },
      );
    }
  })();
  void raw;

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const position = /position (\d+)/u.exec(message);
    const offset = position === null ? 0 : Number(position[1]);
    const before = text.slice(0, offset);
    const line = before.split('\n').length;
    const column = offset - (before.lastIndexOf('\n') + 1) + 1;
    throw new FactoryError(
      'SPEC_INVALID',
      `SPEC_INVALID: ${file}:${line}:${column} <json>: expected a JSON object; got ${message}`,
      { file, line, column },
    );
  }

  const result = UnitSpec.safeParse(parsed);
  if (!result.success) {
    const issue = result.error.issues[0];
    const path = issue === undefined ? '<root>' : formatPath(issue.path);
    const detail = issue === undefined ? 'schema refused the spec' : issue.message;
    const at = issue === undefined ? { line: 1, column: 1 } : locate(text, issue.path);
    const got = issue === undefined ? 'unknown' : JSON.stringify(valueAt(parsed, issue.path));
    throw new FactoryError(
      'SPEC_INVALID',
      `SPEC_INVALID: ${file}:${at.line}:${at.column} ${path}: ${detail}; got ${got}`,
      { file, path, line: at.line, column: at.column },
    );
  }
  return result.data;
}

function valueAt(root: unknown, path: ReadonlyArray<PropertyKey>): unknown {
  let current: unknown = root;
  for (const segment of path) {
    if (typeof segment === 'number') {
      if (!Array.isArray(current)) return undefined;
      current = current[segment];
      continue;
    }
    if (typeof current !== 'object' || current === null) return undefined;
    current = (current as Record<string, unknown>)[String(segment)];
  }
  return current;
}

export function runIntent(input: VerbInput): number {
  const { ctx, options } = input;
  const file = requiredOption(
    options,
    'file',
    'Usage: factory intent --file <spec.json> [--restate <file>]',
  );
  const restateFile = textOption(options, 'restate');
  const spec = readSpec(file, file);

  if (restateFile !== undefined) {
    const text = (() => {
      try {
        return readFileSync(resolve(restateFile), 'utf8');
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new FactoryError(
          'SPEC_INVALID',
          `SPEC_INVALID: ${restateFile}:1:1 <restate>: expected a readable restate-back file; got ${detail}`,
          { file: restateFile },
        );
      }
    })();
    if (text.trim() !== spec.restateBack.trim()) {
      throw new FactoryError(
        'SPEC_INVALID',
        `SPEC_INVALID: ${restateFile}:1:1 restateBack: the restate-back on disk does not match spec.restateBack ` +
          `(file ${contentHash(text.trim())}, spec ${contentHash(spec.restateBack.trim())}); the two must be the ` +
          'same text, because the hash of your restatement is what the mandate binds',
        { file: restateFile, path: 'restateBack' },
      );
    }
  }

  const result = ctx.engine.submitUnit(spec);
  const specHash = result.specHash;
  const restateHash = contentHash(spec.restateBack);
  const criteria = spec.acceptance.length;

  input.emit({
    unitId: result.unit.unitId,
    slug: spec.slug,
    repo: spec.repo,
    revision: spec.revision,
    state: result.unit.state,
    lane: result.unit.lane,
    specHash,
    restateHash,
    created: result.created,
    acceptance: spec.acceptance.map((criterion) => ({
      id: criterion.id,
      text: criterion.text,
      oracle: criterion.oracle.kind,
      target: criterion.oracle.target,
    })),
    next: `factory qualify ${result.unit.unitId}`,
    traceId: ctx.traceId,
  });

  const lines: string[] = [];
  if (result.created) {
    lines.push(field('UNIT', result.unit.unitId));
    lines.push(
      field('SPEC', `${shortHash(specHash)}       (immutable; ${criteria} acceptance criteria)`),
    );
    lines.push(
      field(
        'RESTATE',
        `${shortHash(restateHash)}       (bound to the spec, hashed into the mandate)`,
      ),
    );
  } else {
    lines.push(`UNIT ${result.unit.unitId} (existing - spec hash unchanged, no new mandate)`);
    lines.push(field('SPEC', shortHash(specHash)));
  }
  lines.push('', `ACCEPTANCE CRITERIA  (${criteria} — all machine-checkable)`);
  spec.acceptance.forEach((criterion, index) => {
    lines.push(`  ${index + 1}  ${criterion.text}`);
    lines.push(
      `     oracle=${criterion.oracle.kind}  target=${criterion.oracle.target}  expect=${criterion.oracle.expect}`,
    );
  });
  lines.push(
    '',
    field(
      'TOUCH-PATHS',
      `${spec.touchPaths.join(' · ')}  (budget ${spec.sizeBudget.lines} lines / ${spec.sizeBudget.files} files)`,
    ),
    field(
      'BLAST RADIUS',
      spec.operationClasses.length === 0
        ? 'none declared — no schema migration, no delete, no force-push, no credential use'
        : spec.operationClasses.join(', '),
    ),
  );
  if (restateFile === undefined) {
    lines.push(
      '',
      'WARN restate-back absent — the qualifier will reject this unit (INTENT_NOT_DERIVABLE).',
      '     Add one: factory intent --file <spec.json> --restate <restate-file>',
    );
  }
  lines.push('', 'Lane: not yet qualified.', `Next:  factory qualify ${result.unit.unitId}`);
  for (const line of lines) ctx.ui.err(line);
  return 0;
}

function shortHash(hash: string): string {
  const hex = hash.startsWith('sha256:') ? hash.slice(7) : hash;
  return `sha256:${hex.slice(0, 8)}…`;
}

export const intentVerb: VerbSpec = {
  name: 'intent',
  verb: 'intent',
  summary: 'Submit a unit spec and bind its restate-back',
  configure: (command) => {
    command
      .option('--file <path>', 'path to the JSON unit spec')
      .option('--restate <path>', 'path to the restate-back file (must match spec.restateBack)');
  },
  action: runIntent,
};
