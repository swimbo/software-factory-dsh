/**
 * The boundary around the CLI's test harness.
 *
 * `apps/cli/src/testing.ts` is 289 lines of fixture code sitting in production source.
 * That is a defensible location — its fixtures must drive the real `context.ts` and
 * `main.ts`, or they would be testing a re-implementation — but it is not a defensible
 * *surface*: production code that can import it can ship a test double into a binary.
 *
 * Two properties keep the location honest, and both are asserted here:
 *
 * 1. importing it under `NODE_ENV=production` throws, so a stray import fails loudly in
 *    the one environment where it matters rather than quietly working;
 * 2. nothing outside `*.test.ts` imports it at all, so the gate is a backstop and not
 *    the only control.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const CLI_SRC = dirname(fileURLToPath(import.meta.url));

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.isFile() && entry.name.endsWith('.ts') ? [path] : [];
  });
}

describe('the test harness does not leak into the product', () => {
  it('refuses to load under NODE_ENV=production', () => {
    const harness = join(CLI_SRC, 'testing.ts');
    const result = spawnSync(
      process.execPath,
      [
        '-e',
        `import(${JSON.stringify(harness)}).then(() => console.log('loaded')).catch((e) => { console.error(String(e)); process.exit(1); })`,
      ],
      { cwd: CLI_SRC, encoding: 'utf8', env: { ...process.env, NODE_ENV: 'production' } },
    );

    expect(result.status, `${result.stdout}\n${result.stderr}`).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain('must never be loaded in production');
  });

  it('is imported only by test files', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(CLI_SRC)) {
      if (file.endsWith('.test.ts') || file.endsWith('testing.ts')) continue;
      const text = readFileSync(file, 'utf8');
      if (
        /from\s+['"][^'"]*\/testing\.ts['"]/.test(text) ||
        /from\s+['"]\.\/testing\.ts['"]/.test(text)
      ) {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });
});
