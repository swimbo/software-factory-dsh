/**
 * The per-attempt `DSH_HOME` (amendment A13).
 *
 * Two properties are load-bearing and both are tested here rather than through
 * the executor, because they are about the home and not about a run:
 *
 * 1. the seed is read-only — the template a provisioner froze is not the thing a
 *    worker mutates;
 * 2. the home is per-attempt and contains **only** the profile, so a
 *    `cordis.patch.yml` cannot travel from attempt N to attempt N+1.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { FactoryError } from '@factory/contracts';
import { describe, expect, it } from 'vitest';

import {
  attemptHomePath,
  destroyAttemptHome,
  listHomeFiles,
  readHomeFile,
  readOutSession,
  seedAttemptHome,
  seedTemplateDir,
  WORKER_DOMAIN,
} from '../src/home.ts';
import { DSH_PROFILE } from '../src/executor.ts';
import { tempDir } from './helpers.ts';

const PROFILE = DSH_PROFILE;

/** A factory root with a provisioned template, and nothing else. */
function provisionedRoot(): string {
  const root = tempDir('home');
  const template = seedTemplateDir(root, WORKER_DOMAIN, PROFILE);
  mkdirSync(template, { recursive: true });
  writeFileSync(join(template, 'cordis.yml'), '[]\n');
  writeFileSync(join(template, 'cordis.patch.yml'), '[]\n');
  writeFileSync(join(template, 'package.json'), '{"name":"template"}\n');
  return root;
}

/** A stable fingerprint of a directory tree, for the read-only assertion. */
function treeHash(dir: string): string {
  const hash = createHash('sha256');
  const files = listHomeFiles(dir).sort();
  for (const file of files) hash.update(file).update(readFileSync(join(dir, file)));
  return hash.digest('hex');
}

describe('seedAttemptHome', () => {
  it('copies the profile and nothing else', () => {
    const root = provisionedRoot();
    const home = seedAttemptHome({ root, attemptId: 'a1', profile: PROFILE });

    expect(listHomeFiles(home)).toStrictEqual([
      `profiles/${PROFILE}/cordis.patch.yml`,
      `profiles/${PROFILE}/cordis.yml`,
      `profiles/${PROFILE}/package.json`,
    ]);
    expect(readHomeFile(home, `profiles/${PROFILE}/package.json`)).toBe('{"name":"template"}\n');
  });

  it('does not inherit a home patch layer, which composes into every profile', () => {
    // findings D5: `$DSH_HOME/cordis.patch.yml` applies to every profile in that
    // home. If seeding copied it, an attempt could inherit a configuration no
    // one reviewed.
    const root = provisionedRoot();
    writeFileSync(join(root, 'dsh-home', WORKER_DOMAIN, 'cordis.patch.yml'), '- id: smuggled\n');
    const home = seedAttemptHome({ root, attemptId: 'a1', profile: PROFILE });
    expect(existsSync(join(home, 'cordis.patch.yml'))).toBe(false);
  });

  it('does not inherit sessions or storages left in the template', () => {
    const root = provisionedRoot();
    const seedRoot = join(root, 'dsh-home', WORKER_DOMAIN);
    mkdirSync(join(seedRoot, 'sessions', 'old'), { recursive: true });
    writeFileSync(join(seedRoot, 'sessions', 'old', 'session.v4.jsonl'), 'stale\n');
    mkdirSync(join(seedRoot, 'storages', 'session_projcache'), { recursive: true });
    writeFileSync(join(seedRoot, 'storages', 'session_projcache', 'x.json'), '{}\n');

    const home = seedAttemptHome({ root, attemptId: 'a1', profile: PROFILE });
    expect(listHomeFiles(home).some((file) => file.startsWith('sessions/'))).toBe(false);
    expect(listHomeFiles(home).some((file) => file.startsWith('storages/'))).toBe(false);
  });

  it('leaves the template byte-identical', () => {
    const root = provisionedRoot();
    const template = seedTemplateDir(root, WORKER_DOMAIN, PROFILE);
    const before = treeHash(template);
    const home = seedAttemptHome({ root, attemptId: 'a1', profile: PROFILE });
    // The attempt writes to its own home; the template is a frozen input.
    writeFileSync(join(home, 'profiles', PROFILE, 'cordis.patch.yml'), '- id: attempt-owned\n');
    expect(treeHash(template)).toBe(before);
  });

  it('gives every attempt its own home', () => {
    const root = provisionedRoot();
    const first = seedAttemptHome({ root, attemptId: 'a1', profile: PROFILE });
    const second = seedAttemptHome({ root, attemptId: 'a2', profile: PROFILE });
    expect(first).not.toBe(second);
    writeFileSync(join(first, 'profiles', PROFILE, 'cordis.patch.yml'), '- id: attempt-1-only\n');
    expect(readHomeFile(second, `profiles/${PROFILE}/cordis.patch.yml`)).toBe('[]\n');
  });

  it('starts a re-seeded attempt from the template, not from the last run', () => {
    // The contamination channel A13 closes: attempt 1 writes a patch entry into
    // its home; attempt 2 for the same id must not see it.
    const root = provisionedRoot();
    const first = seedAttemptHome({ root, attemptId: 'a1', profile: PROFILE });
    writeFileSync(join(first, 'profiles', PROFILE, 'cordis.patch.yml'), '- id: from-attempt-1\n');
    const again = seedAttemptHome({ root, attemptId: 'a1', profile: PROFILE });
    expect(readHomeFile(again, `profiles/${PROFILE}/cordis.patch.yml`)).toBe('[]\n');
  });

  it('refuses to seed from a home that was never provisioned', () => {
    const root = tempDir('home-empty');
    expect(() => seedAttemptHome({ root, attemptId: 'a1', profile: PROFILE })).toThrow(
      FactoryError,
    );
    expect(() => seedAttemptHome({ root, attemptId: 'a1', profile: PROFILE })).toThrow(
      /provision-dsh-home\.sh/,
    );
  });

  it('refuses an attempt id that would escape the home tree', () => {
    const root = provisionedRoot();
    expect(() => attemptHomePath(root, '../../etc')).toThrow(/unsafe attemptId/);
    expect(() => seedAttemptHome({ root, attemptId: '..', profile: PROFILE })).toThrow(
      /unsafe attemptId/,
    );
  });
});

describe('readOutSession', () => {
  it('copies the session log out with its cwd-keyed path intact', () => {
    const root = provisionedRoot();
    const home = seedAttemptHome({ root, attemptId: 'a1', profile: PROFILE });
    const slug = '--Users-bo-.factory-attempts-u1-a1-checkout--';
    mkdirSync(join(home, 'sessions', slug, 'sess-1'), { recursive: true });
    writeFileSync(join(home, 'sessions', slug, 'sess-1', 'session.v4.jsonl.zstd'), 'log\n');
    mkdirSync(join(home, 'storages', 'session_projcache', 'sessions'), { recursive: true });
    writeFileSync(join(home, 'storages', 'session_projcache', 'sessions', 'sess-1.json'), '{}\n');

    const destination = join(tempDir('readout'), 'session');
    const files = readOutSession(home, destination);

    expect(files).toHaveLength(2);
    const log = files.find((file) => file.path.endsWith('.jsonl.zstd'));
    expect(log?.path).toBe(join(destination, 'sessions', slug, 'sess-1', 'session.v4.jsonl.zstd'));
    expect(log?.bytes).toBe(4);
    expect(readFileSync(log?.path ?? '', 'utf8')).toBe('log\n');
    expect(files.every((file) => file.path.startsWith(destination))).toBe(true);
  });

  it('captures nothing when the attempt wrote no session', () => {
    const root = provisionedRoot();
    const home = seedAttemptHome({ root, attemptId: 'a1', profile: PROFILE });
    expect(readOutSession(home, join(tempDir('readout'), 'session'))).toStrictEqual([]);
  });
});

describe('destroyAttemptHome', () => {
  it('removes the home and everything in it', () => {
    const root = provisionedRoot();
    const home = seedAttemptHome({ root, attemptId: 'a1', profile: PROFILE });
    mkdirSync(join(home, 'sessions'), { recursive: true });
    destroyAttemptHome(home);
    expect(existsSync(home)).toBe(false);
    // The template survives, and so does the parent it lives under.
    expect(existsSync(join(root, 'dsh-home', WORKER_DOMAIN))).toBe(true);
    expect(existsSync(join(root, 'dsh-home', 'attempts'))).toBe(true);
  });

  it('is idempotent, because it runs on the failure paths too', () => {
    const root = provisionedRoot();
    const home = seedAttemptHome({ root, attemptId: 'a1', profile: PROFILE });
    destroyAttemptHome(home);
    expect(() => destroyAttemptHome(home)).not.toThrow();
  });
});

describe('listHomeFiles', () => {
  it('is empty for a home that does not exist', () => {
    expect(listHomeFiles(join(tempDir('nope'), 'missing'))).toStrictEqual([]);
    expect(readdirSync(join(tempDir('nope2'), '.'))).toStrictEqual([]);
  });
});
