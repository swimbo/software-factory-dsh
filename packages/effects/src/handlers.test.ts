/**
 * The handler contract's two helpers.
 *
 * `defineEffectHandler` exists to keep one cast in one place (payload typing) and
 * to make payload validation the default rather than a good intention;
 * `indexHandlers` exists so an ambiguous kind is a startup failure instead of a
 * coin flip at dispatch time.
 */
import { describe, expect, it } from 'vitest';
import { defineEffectHandler, indexHandlers } from './handlers.ts';

interface LaunchPayload {
  readonly unitId: string;
  readonly attemptDir: string;
}

describe('defineEffectHandler', () => {
  it('passes the payload through untouched when no parse step is given', async () => {
    const seen: unknown[] = [];
    const handler = defineEffectHandler({
      kind: 'launch-attempt',
      run: async (payload: unknown): Promise<void> => {
        seen.push(payload);
      },
    });

    await handler.run({ unitId: 'unit-1' }, { effectId: 'eff-1', attempt: 1 });

    expect(seen).toEqual([{ unitId: 'unit-1' }]);
  });

  it('hands the handler the parsed value, not the raw row', async () => {
    const seen: LaunchPayload[] = [];
    const handler = defineEffectHandler<LaunchPayload>({
      kind: 'launch-attempt',
      parse: (raw) => {
        const value = raw as { unitId?: unknown; attemptDir?: unknown };
        if (typeof value.unitId !== 'string' || typeof value.attemptDir !== 'string') {
          throw new TypeError('launch-attempt payload needs unitId and attemptDir');
        }
        return { unitId: value.unitId, attemptDir: value.attemptDir };
      },
      run: async (payload): Promise<void> => {
        seen.push(payload);
      },
    });

    await handler.run(
      { unitId: 'unit-1', attemptDir: '/tmp/a1', retries: 0 },
      { effectId: 'eff-1', attempt: 1 },
    );

    expect(seen).toEqual([{ unitId: 'unit-1', attemptDir: '/tmp/a1' }]);
  });

  it('refuses a payload that does not parse, before the handler sees it', async () => {
    let invoked = 0;
    const handler = defineEffectHandler<LaunchPayload>({
      kind: 'launch-attempt',
      parse: (raw) => {
        const value = raw as { unitId?: unknown };
        if (typeof value.unitId !== 'string') throw new TypeError('payload needs unitId');
        return { unitId: value.unitId, attemptDir: '/tmp/a1' };
      },
      run: async (): Promise<void> => {
        invoked += 1;
      },
    });

    await expect(handler.run({}, { effectId: 'eff-1', attempt: 1 })).rejects.toThrow(
      /payload needs unitId/,
    );
    expect(invoked).toBe(0);
  });

  it('keeps the declared kind', () => {
    const handler = defineEffectHandler({ kind: 'promote-change', run: async () => {} });
    expect(handler.kind).toBe('promote-change');
  });
});

describe('indexHandlers', () => {
  it('routes by kind', () => {
    const launch = defineEffectHandler({ kind: 'launch-attempt', run: async () => {} });
    const promote = defineEffectHandler({ kind: 'promote-change', run: async () => {} });

    const byKind = indexHandlers([launch, promote]);

    expect(byKind.size).toBe(2);
    expect(byKind.get('launch-attempt')).toBe(launch);
    expect(byKind.get('promote-change')).toBe(promote);
    expect(byKind.get('unknown')).toBeUndefined();
  });

  it('refuses two handlers for one kind', () => {
    const first = defineEffectHandler({ kind: 'launch-attempt', run: async () => {} });
    const second = defineEffectHandler({ kind: 'launch-attempt', run: async () => {} });

    expect(() => indexHandlers([first, second])).toThrow(
      /duplicate handler for kind "launch-attempt"/,
    );
  });

  it('refuses an empty kind', () => {
    expect(() => indexHandlers([defineEffectHandler({ kind: '  ', run: async () => {} })])).toThrow(
      /kind must be a non-empty string/,
    );
  });

  it('accepts no handlers at all (every effect then fails as unhandled)', () => {
    expect(indexHandlers([]).size).toBe(0);
  });
});
