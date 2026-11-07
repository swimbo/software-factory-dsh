/**
 * The class descriptor: what a task class *declares* about itself, kept beside the corpus it describes.
 *
 * A holdout corpus on its own is a set of rules and a manifest. That is enough for the wall to measure a
 * candidate, and not enough for anyone to see whether the class is worth having. The three questions a
 * descriptor answers are the three that decide whether a certificate means anything:
 *
 * 1. **What does the worker get to see?** `visibleCheck` is the command the wall runs as the pinned
 *    suite, and `visibleRules` names the subset of the class's rules that command actually enforces.
 *    For the wall to be an oracle rather than a mirror, that subset has to be *strict*: at least one
 *    rule must be invisible to the worker. A visible check that covers every rule measures whether the
 *    worker ran the linter, not whether the change is right.
 * 2. **Which rules does the class actually have?** `rules` must name exactly the manifest's scenario ids.
 *    A descriptor that promises a rule the corpus does not run is a class that certifies a subset of what
 *    it claims.
 * 3. **What proves each rule can fail?** `mutationMatrix` pairs a defect with the rules that must redden
 *    when it is planted. A rule no defect reddens is a rule that has never been observed failing — the
 *    "starts red" property, in the form a spec can check.
 *
 * This file is intentionally only the *declaration* and its parse. The judgements live in `doctor.ts`,
 * and the scaffolding that writes a descriptor lives in `scaffold.ts`; a class is authored by a person,
 * and the tooling's job is to make the declaration unskippable rather than to invent its content.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const CLASS_DESCRIPTOR_FILE = 'class.json';

export interface ClassDescriptor {
  readonly taskClass: string;
  /** The command the wall runs as its own gate (FACTORY_WALL_SUITE). */
  readonly visibleCheck: {
    readonly argv: readonly string[];
    /** Whether the command must print `FACTORY_SUMMARY {…}`; true for a pinned suite. */
    readonly requireSummary: boolean;
  };
  /** Every rule id the class has — exactly the manifest's scenario ids. */
  readonly rules: readonly string[];
  /** The subset of `rules` the visible check enforces. Must be strict. */
  readonly visibleRules: readonly string[];
  /** Each planted defect and the rules that must fail when it is planted. */
  readonly mutationMatrix: readonly {
    readonly defect: string;
    readonly redRules: readonly string[];
  }[];
}

export type DescriptorParse =
  | { readonly kind: 'ok'; readonly descriptor: ClassDescriptor }
  | { readonly kind: 'missing'; readonly path: string }
  | { readonly kind: 'unreadable'; readonly path: string; readonly reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function strings(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string' || item.trim() === '') return null;
    out.push(item);
  }
  return out;
}

/** Parse a descriptor from already-parsed JSON. Returns a sentence for every way it can be wrong. */
export function parseClassDescriptor(
  value: unknown,
):
  | { readonly kind: 'ok'; readonly descriptor: ClassDescriptor }
  | { readonly kind: 'invalid'; readonly reason: string } {
  if (!isRecord(value)) return { kind: 'invalid', reason: 'the descriptor is not a JSON object' };
  const { taskClass, visibleCheck, rules, visibleRules, mutationMatrix } = value;
  if (typeof taskClass !== 'string' || taskClass.trim() === '') {
    return { kind: 'invalid', reason: 'taskClass must be a non-empty string' };
  }
  if (!isRecord(visibleCheck)) return { kind: 'invalid', reason: 'visibleCheck must be an object' };
  const argv = strings(visibleCheck['argv']);
  if (argv === null || argv.length === 0) {
    return { kind: 'invalid', reason: 'visibleCheck.argv must be a non-empty array of strings' };
  }
  const requireSummary = visibleCheck['requireSummary'];
  if (typeof requireSummary !== 'boolean') {
    return { kind: 'invalid', reason: 'visibleCheck.requireSummary must be a boolean' };
  }
  const ruleIds = strings(rules);
  if (ruleIds === null || ruleIds.length === 0) {
    return { kind: 'invalid', reason: 'rules must be a non-empty array of rule ids' };
  }
  const visible = strings(visibleRules);
  if (visible === null)
    return { kind: 'invalid', reason: 'visibleRules must be an array of rule ids' };
  if (!Array.isArray(mutationMatrix)) {
    return { kind: 'invalid', reason: 'mutationMatrix must be an array' };
  }
  const matrix: { defect: string; redRules: string[] }[] = [];
  for (const [index, entry] of mutationMatrix.entries()) {
    if (!isRecord(entry)) {
      return { kind: 'invalid', reason: `mutationMatrix[${String(index)}] is not an object` };
    }
    const defect = entry['defect'];
    if (typeof defect !== 'string' || defect.trim() === '') {
      return {
        kind: 'invalid',
        reason: `mutationMatrix[${String(index)}].defect must be a non-empty string`,
      };
    }
    const redRules = strings(entry['redRules']);
    if (redRules === null || redRules.length === 0) {
      return {
        kind: 'invalid',
        reason: `mutationMatrix[${String(index)}].redRules must name at least one rule; a defect that reddens nothing proves nothing`,
      };
    }
    matrix.push({ defect, redRules });
  }
  return {
    kind: 'ok',
    descriptor: {
      taskClass,
      visibleCheck: { argv, requireSummary },
      rules: ruleIds,
      visibleRules: visible,
      mutationMatrix: matrix,
    },
  };
}

/** Read and parse `<revisionDir>/class.json`. */
export function readClassDescriptor(revisionDir: string): DescriptorParse {
  const path = join(revisionDir, CLASS_DESCRIPTOR_FILE);
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return { kind: 'missing', path };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return {
      kind: 'unreadable',
      path,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
  const result = parseClassDescriptor(parsed);
  if (result.kind === 'invalid') return { kind: 'unreadable', path, reason: result.reason };
  return { kind: 'ok', descriptor: result.descriptor };
}
