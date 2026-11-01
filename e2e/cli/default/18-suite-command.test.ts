import { describe, expect, it } from 'vitest';

import { selectSuiteCommand, testRefusal } from '../../harness/suite-command.ts';

/**
 * A test must never re-run the worker.
 *
 * The live spec selected its "re-run the suite by hand" command with
 * `commands.find((c) => c.argv.join(' ').includes('suite'))`. The launch carries the whole prompt
 * as an argv element, and the prompt says "suite", so that finder returned `commands[0]` — and the
 * assertion executed `dsh` a second time. It cost 17.8 s instead of ~1 s and, on a live attempt,
 * would have been a **paid model call made by a test assertion**, which is the one thing the live
 * opt-in exists to keep deliberate.
 */
describe('the suite command a test may re-run is selected structurally', () => {
  const dshBin = '/opt/dsh/bin/dsh';
  const launch = {
    argv: [dshBin, '--profile', 'factory-worker', '--json', 'Make the suite pass in src/slug.js'],
    source: 'worker-launch' as const,
    cwd: '/tmp/attempt',
  };
  const suite = {
    argv: ['node', 'tests/suite.js'],
    source: 'factory-verification' as const,
    cwd: '/tmp/attempt',
  };

  it('picks the node command, not the launch whose prompt mentions "suite"', () => {
    const picked = selectSuiteCommand([launch, suite]);
    expect(picked?.argv).toStrictEqual(['node', 'tests/suite.js']);
    expect(picked?.source).toBe('factory-verification');
  });

  it('refuses the launch even when it is the only candidate', () => {
    expect(selectSuiteCommand([launch])).toBeNull();
    expect(testRefusal(launch.argv, dshBin)).toMatch(/never re-run the worker/u);
  });

  it('refuses anything that is not a suite command, and any --profile launch', () => {
    expect(testRefusal(['node', 'tests/suite.js'], dshBin)).toBeNull();
    expect(testRefusal(['git', 'status'], dshBin)).toMatch(/not a suite command/u);
    expect(testRefusal(['/somewhere/dsh', '--json', 'x'], dshBin)).toMatch(
      /never re-run the worker/u,
    );
    expect(testRefusal([], dshBin)).toMatch(/empty argv/u);
  });

  it('never selects a worker-launch command even if its source claims verification', () => {
    const lying = {
      argv: [dshBin, '--profile', 'x', 'suite'],
      source: 'factory-verification' as const,
    };
    // Structural selection is on `source` + `node`; the guard is the second line of defence.
    expect(selectSuiteCommand([lying])).toBeNull();
    expect(testRefusal(lying.argv, dshBin)).toMatch(/never re-run the worker/u);
  });
});
