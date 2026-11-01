/**
 * The shape every verb takes: a pure action plus the declaration of its surface.
 *
 * `main.ts` owns commander and the error funnel; a verb owns one question
 * ("what does this command do to the factory?") and receives a context. That
 * split is what lets the verbs be exercised directly with an injected clock, a
 * temp `FACTORY_HOME` and a fake executor — the same seam the e2e suite uses
 * through the real binary.
 */
import type { Command } from 'commander';

import type { FactoryContext } from '../context.ts';
import { UsageError } from '../exit.ts';
import type { Verb } from '../render/limits.ts';

export type Json = Record<string, unknown>;

export interface VerbInput {
  readonly ctx: FactoryContext;
  /** Positional arguments, in declaration order. */
  readonly args: readonly string[];
  /** Parsed long flags, e.g. `--file` → `file`. */
  readonly options: Readonly<Record<string, unknown>>;
  /** Emit this command's single `--json` object. A no-op when `--json` is absent. */
  readonly emit: (payload: object) => void;
}

export interface VerbSpec {
  readonly name: string;
  readonly verb: Verb;
  readonly summary: string;
  /** Commander argument declarations, e.g. `['<unitId>']`. */
  readonly arguments?: readonly string[];
  readonly configure: (command: Command) => void;
  readonly action: (input: VerbInput) => number | Promise<number>;
}

export function textOption(
  options: Readonly<Record<string, unknown>>,
  key: string,
): string | undefined {
  const value = options[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') return undefined;
  return value.trim().length === 0 ? undefined : value;
}

export function requiredOption(
  options: Readonly<Record<string, unknown>>,
  key: string,
  usage: string,
): string {
  const value = textOption(options, key);
  if (value === undefined) throw new UsageError(`USAGE: missing --${key}. ${usage}`);
  return value;
}

export function boolOption(options: Readonly<Record<string, unknown>>, key: string): boolean {
  return options[key] === true;
}

export function numberOption(
  options: Readonly<Record<string, unknown>>,
  key: string,
  usage: string,
): number {
  const raw = textOption(options, key);
  if (raw === undefined) throw new UsageError(`USAGE: missing --${key}. ${usage}`);
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new UsageError(`USAGE: --${key} expects a number, got ${JSON.stringify(raw)}. ${usage}`);
  }
  return value;
}
