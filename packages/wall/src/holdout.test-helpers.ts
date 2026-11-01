/**
 * Test-only scaffolding: write a holdout store the wall can read.
 *
 * This lives in `src/` so both wall test files can share it, and it is named
 * `.test-helpers.ts` so it is obviously not part of the package's runtime surface.
 * It writes only where the test tells it to (a fresh temp directory), which is why
 * the "no filesystem writes" rule for this package is still intact.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { contentHash } from '@factory/contracts';
import { hashableScenarios, type HoldoutStore } from './holdout.ts';

/**
 * Write `<root>/<taskClass>/<revision>/manifest.json` and return the revision hash
 * that was written, so a test can prove the loader accepts the exact artefact the
 * writer produced (and rejects it once any byte of it changes).
 */
export function writeHoldoutStore(root: string, store: HoldoutStore): string {
  const dir = join(root, store.taskClass, store.revision);
  mkdirSync(dir, { recursive: true });
  const revisionHash = contentHash(hashableScenarios(store.scenarios));
  const manifest = {
    revision: store.revision,
    taskClass: store.taskClass,
    scenarios: hashableScenarios(store.scenarios),
    revisionHash,
  };
  writeFileSync(join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return revisionHash;
}

/** Write an arbitrary manifest body, for testing the loader's rejection paths. */
export function writeRawManifest(
  root: string,
  taskClass: string,
  revision: string,
  body: string,
): void {
  const dir = join(root, taskClass, revision);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'manifest.json'), body);
}
