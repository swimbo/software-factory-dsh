/**
 * One parity, asserted rather than assumed: the CLI's bypass-flag refusal and the
 * gate package's list must be the same list.
 *
 * They are duplicated on purpose — `exit.ts` must refuse `-y` *before* commander
 * parses, including for a verb that has not been written yet, so it cannot wait to
 * import `@factory/gates`. The cost of that duplication is exactly one possible
 * bug: the two lists drift, and a flag the gates refuse is silently accepted by
 * the CLI. This test is that cost's insurance.
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { BYPASS_FLAGS, refuseBypassFlags, UsageError } from './exit.ts';

const GATES_BUDGET = fileURLToPath(
  new URL('../../../packages/gates/src/budget.ts', import.meta.url),
);

describe('bypass flags', () => {
  it.skipIf(!existsSync(GATES_BUDGET))(
    "matches @factory/gates' BYPASS_FLAGS exactly (edit both or neither)",
    () => {
      const source = readFileSync(GATES_BUDGET, 'utf8');
      const declaration = /export const BYPASS_FLAGS = \[(?<list>[^\]]*)\]/u.exec(source);
      expect(
        declaration?.groups?.['list'],
        'BYPASS_FLAGS not found in packages/gates/src/budget.ts',
      ).toBeDefined();
      const flags = [...(declaration?.groups?.['list'] ?? '').matchAll(/'([^']+)'/gu)].map(
        (match) => match[1],
      );
      expect(flags.length).toBeGreaterThan(0);
      expect([...BYPASS_FLAGS]).toEqual(flags);
    },
  );

  it('refuses every flag in the list, wherever it appears in argv', () => {
    for (const flag of BYPASS_FLAGS) {
      for (const argv of [
        [flag],
        ['promote', 'U-1', flag],
        ['budget', 'raise', flag, '--to', '4.00'],
      ]) {
        expect(
          () => {
            refuseBypassFlags(argv);
          },
          `${argv.join(' ')}`,
        ).toThrow(UsageError);
      }
    }
  });

  it('does not refuse a flag that merely contains one of them', () => {
    // Exact matching, not prefix matching: a future `--force-rescore` must not
    // trip the `--force` refusal, and `--yes-please-no` is simply an unknown flag
    // (commander refuses it as a usage error, without this function's help).
    for (const argv of [['--json'], ['--force-rescore'], ['--no-color'], ['--yes-please-no']]) {
      expect(() => {
        refuseBypassFlags(argv);
      }, argv.join(' ')).not.toThrow();
    }
  });

  it('names the flag it refused and the exit contract in the message', () => {
    try {
      refuseBypassFlags(['promote', 'U-1', '--yes']);
      expect.unreachable('refuseBypassFlags should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(UsageError);
      expect((error as UsageError).message).toContain('--yes');
      expect((error as UsageError).message).toContain('exit 2');
    }
  });
});
