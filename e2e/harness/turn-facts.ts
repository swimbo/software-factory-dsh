import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect } from 'vitest';

/**
 * What a real `dsh` transcript says about a turn.
 *
 * Extracted from the live spec so the reader can be measured against a recorded transcript with
 * no key, no `dsh` spawn and no network: the shape here is the shape `dsh 0.2.1-rc.3` emits, and
 * `{"type":"status","phase":"step_end"}` puts `step_end` in the *phase*, not the type. A reader
 * that matched on `type === 'step_end'` reported zero tokens for a turn that spent 12,706.
 */
export interface TurnFact {
  readonly raw: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
}

/**
 * Read the attempt's NDJSON stream and summarise the turn.
 *
 * Read from `stdout.log` rather than from the receipt, deliberately: the receipt carries the
 * *conclusion* (`turnsUsed`, ceilings), and the raw stream is where the model's own claims live.
 * A faithful-receipt spec has to look at both, or it proves only that a file exists.
 */
export function readTurn(recordDir: string): {
  readonly completed: boolean;
  readonly usage: TurnFact | null;
  readonly errors: readonly string[];
} {
  const path = join(recordDir, 'stdout.log');
  // A helper that returns "nothing happened" when the file is absent is how a test stops
  // measuring: the attempt directory either holds the transcript or the spec is looking in the
  // wrong place, and those are different failures.
  expect(existsSync(path), `no stdout.log in ${recordDir}`).toBe(true);
  let completed = false;
  let usage: TurnFact | null = null;
  const errors: string[] = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (line.trim() === '') continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const type = String(event['type'] ?? '');
    const phase = String(event['phase'] ?? '');
    const isTurnEnd = type === 'turn_end' || (type === 'status' && phase === 'turn_end');
    if (isTurnEnd) {
      const reason = (event['reason'] ?? {}) as { kind?: unknown };
      if (reason.kind === 'completed') completed = true;
    }
    // `dsh` emits `{"type":"status","phase":"step_end"}` — the phase carries step_end, not the
    // type. Matching on `type === 'step_end'` alone found no usage at all, which is why a real
    // paid turn reported "0 tokens" while its transcript held 6,089 and 6,617.
    const isStepEnd = type === 'step_end' || (type === 'status' && phase === 'step_end');
    if (isStepEnd || isTurnEnd) {
      const raw = (event['usage'] ?? {}) as Record<string, unknown>;
      const total = typeof raw['totalTokens'] === 'number' ? raw['totalTokens'] : undefined;
      if (total !== undefined && total > 0) {
        const model = typeof event['model'] === 'string' ? event['model'] : '(not reported)';
        usage = {
          raw: model,
          inputTokens: typeof raw['inputTokens'] === 'number' ? raw['inputTokens'] : 0,
          outputTokens: typeof raw['outputTokens'] === 'number' ? raw['outputTokens'] : 0,
          totalTokens: total,
        };
      }
    }
    if (type === 'error' || event['error'] !== undefined) {
      const message = String((event['error'] as { message?: unknown })?.message ?? event['error']);
      errors.push(message.slice(0, 300));
    }
  }
  return { completed, usage, errors };
}
