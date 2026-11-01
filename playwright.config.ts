import { defineConfig, devices } from '@playwright/test';

/**
 * Browser specs for the read-only status page.
 *
 * There is deliberately **no `webServer` and no `baseURL`** here. A shared background
 * panel is how browser suites become order-dependent: one spec's seeded unit shows up
 * in another spec's page, and a green run stops meaning anything. Every spec instead
 * starts the real panel (`apps/panel/src/main.ts`) on an ephemeral port against its
 * own temp `FACTORY_HOME`, so the origin is a per-test fact and `page.goto()` uses an
 * absolute URL from the spec's own panel handle — "baseURL set per test", enforced by
 * construction rather than by configuration.
 *
 * Retries are 0 on purpose: a gate that retries until it passes is a false gate.
 *
 * Browsers: these specs need the Chromium build that matches `@playwright/test`. If
 * `playwright test` reports "Executable doesn't exist", run `npx playwright install
 * chromium` once — no spec downloads anything at run time, and none touches the network
 * beyond `127.0.0.1`.
 */
export default defineConfig({
  testDir: './e2e/panel',
  testMatch: '**/*.spec.ts',
  // Each file owns a temp store and a panel process, so files are independent.
  fullyParallel: true,
  // A stray `.only` in a committed spec would silently shrink the gate.
  forbidOnly: true,
  retries: 0,
  reporter: 'list',
  timeout: 30_000,
  expect: { timeout: 5_000 },
  use: {
    // No trace: these specs assert server-rendered HTML, and a trace per test would
    // dominate the runtime of a suite whose whole value is being fast enough to gate.
    trace: 'off',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
