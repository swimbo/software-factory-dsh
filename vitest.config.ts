import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/**/*.test.ts', 'apps/**/*.test.ts', 'e2e/cli/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    // The per-test budget has to be longer than the slowest legitimate test, or it
    // measures the scheduler instead of the code. The e2e specs spawn real `factory`
    // children and several run a git clone plus a wall evaluation inside the attempt:
    // 15-25 s is ordinary, and at 20 s three different untouched specs timed out in
    // different runs -- each one passing in isolation. 60 s still catches a hang (the
    // whole test stage is ~40 s quietly), and the cap below keeps the queue from
    // becoming the thing that fails.
    testTimeout: 60_000,
    maxWorkers: 4,
  },
});
