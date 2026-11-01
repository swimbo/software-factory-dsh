import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/**/*.test.ts', 'apps/**/*.test.ts', 'e2e/cli/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    // 20 s is a per-test budget, and the e2e specs are not per-test cheap: each one
    // spawns real `factory` children, and several run a git clone plus a wall
    // evaluation inside the attempt. With ten cores all in flight at once, two of
    // them were starving past 20 s on an idle machine -- not a slow test, a
    // throughput mismatch. Cap the workers so the budget measures the test and not
    // the queue: raising the timeout instead would hide the next stall rather than
    // the current one.
    testTimeout: 20_000,
    maxWorkers: 4,
  },
});
