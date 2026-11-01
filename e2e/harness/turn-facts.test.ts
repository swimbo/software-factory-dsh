import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { readTurn } from './turn-facts.ts';

/**
 * A turn that spent 43,680 tokens is not reported as zero.
 *
 * The transcript is real: six `{"type":"status","phase":"step_end","usage":…}` lines and one
 * `turn_end` copied verbatim from a paid live attempt (`U-20be8c159df8`-era, the run on
 * 2026-11-01) and stripped of nothing but the surrounding prompt/thinking/tool events. The
 * reader it pins matched `type === 'step_end'`, which is never what `dsh 0.2.1-rc.3` emits — the
 * phase carries it — so a real 43,680-token turn was reported as 0 and the live spec's
 * "usage > 0" assertion failed on a model turn that had actually completed.
 */
describe('a real dsh transcript is read as a turn, not as silence', () => {
  const recordDir = join(import.meta.dirname, '__fixtures__', 'dsh-live-turn');

  it('[a turn that spent 43,680 tokens is not reported as zero]', () => {
    const turn = readTurn(recordDir);
    expect(turn.completed).toBe(true);
    expect(turn.errors).toStrictEqual([]);
    // The last step, verbatim from the transcript: 444 in / 151 out / 8147 total / 7552 cache read.
    expect(turn.usage?.totalTokens).toBe(8147);
    expect(turn.usage?.inputTokens).toBe(444);
    expect(turn.usage?.outputTokens).toBe(151);
    expect(turn.usage?.totalTokens ?? 0).toBeGreaterThan(0);
  });
});
