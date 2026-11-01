/**
 * The classifier's job: know what will run, not what was typed.
 *
 * Every spec here is a *bypass*, because that is what a classifier is for. A test that
 * asserted `['sudo','ls']` is privileged would pass against a `String.includes('sudo')`
 * and prove nothing. The cases below are the ones the wall's denylist does not catch:
 * shell strings, wrapper binaries, path-qualified binaries, and dynamic command positions.
 */
import { describe, expect, it } from 'vitest';
import { classify, operationSha, tokeniseShell } from './classify.ts';

const HOME = '/Users/operator';
const classifyIn = (argv: readonly string[]) => classify(argv, { home: HOME });

describe('it classifies the binary that will actually run', () => {
  it('classifies a plain sudo operation', () => {
    const result = classifyIn(['sudo', 'ls', '-la']);
    expect(result.privileged).toBe(true);
    expect(result.operationClass).toBe('privileged');
    expect(result.ruleId).toBe('sudo.exec');
    expect(result.ambiguous).toBe(false);
  });

  it('classifies a path-qualified binary as the same operation', () => {
    const result = classifyIn(['/usr/bin/sudo', 'ls']);
    expect(result.privileged).toBe(true);
    expect(result.ruleId).toBe('sudo.exec');
    // The point of normalising: a path prefix must not be a bypass, and must not change
    // the operation a decision binds to either.
    expect(operationSha(result)).toBe(operationSha(classifyIn(['sudo', 'ls'])));
  });

  it('classifies a shell script by parsing it, not by searching it', () => {
    const result = classifyIn(['sh', '-c', 'sudo rm -rf /tmp/cache']);
    expect(result.privileged).toBe(true);
    expect(result.ruleId).toBe('sudo.exec');
    expect(result.ambiguous).toBe(false);
  });

  it('classifies a wrapper-wrapped command', () => {
    for (const argv of [
      ['env', 'FOO=1', 'sudo', 'ls'],
      ['xargs', 'sudo', 'rm'],
      ['nice', '-n', '5', 'sudo', 'ls'],
      ['timeout', '10', 'sudo', 'ls'],
      ['command', 'sudo', 'ls'],
      ['nohup', 'sudo', 'ls'],
    ]) {
      const result = classifyIn(argv);
      expect(result.privileged, argv.join(' ')).toBe(true);
      expect(result.ruleId, argv.join(' ')).toBe('sudo.exec');
    }
  });

  it('does not classify an ordinary shell script as privileged', () => {
    const result = classifyIn(['sh', '-c', 'echo hello && node --test']);
    expect(result.privileged).toBe(false);
    expect(result.ambiguous).toBe(false);
    expect(result.operationClass).toBe('code-change');
  });
});

describe('ambiguity is fail-closed (L3)', () => {
  it('refuses an operation whose command position is a dynamic expansion', () => {
    const result = classifyIn(['sh', '-c', 'X=sudo; $X rm -rf /']);
    expect(result.privileged).toBe(false);
    expect(result.ambiguous).toBe(true);
    expect(result.ruleId).toBe('ambiguous.dynamic-word');
  });

  it('refuses an unknown binary that names a privileged path', () => {
    const result = classifyIn(['mytool', '/etc/hosts']);
    expect(result.ambiguous).toBe(true);
    expect(result.ruleId).toBe('ambiguous.unknown-writer');
    // Not privileged, and that distinction matters: "we know this is bad" and "we cannot
    // tell" have the same outcome for the caller but different reasons for the audit.
    expect(result.privileged).toBe(false);
  });

  it('refuses a shell script built from an expansion', () => {
    const result = classifyIn(['sh', '-c', '$(which sudo) ls']);
    expect(result.ambiguous).toBe(true);
    // One rule for one fact: the script tokenises to a segment whose command position is
    // an expansion, which is the same condition as `$X rm` — so the rule id is the same.
    expect(result.ruleId).toBe('ambiguous.dynamic-word');
  });
});

describe('privileged paths are recognised segment-wise', () => {
  it('classifies a write into /etc by a known writer', () => {
    const result = classifyIn(['cp', '/etc/hosts', '/tmp/hosts']);
    expect(result.privileged).toBe(true);
    expect(result.ruleId).toBe('path-write:/etc/hosts');
  });

  it('classifies a redirect into a privileged path', () => {
    const result = classifyIn(['sh', '-c', 'echo x > ~/.ssh/authorized_keys']);
    expect(result.privileged).toBe(true);
    expect(result.ruleId).toBe(`path-write:redirect:${HOME}/.ssh/authorized_keys`);
  });

  it('does not treat an ordinary copy as privileged', () => {
    const result = classifyIn(['cp', 'src/a.ts', 'src/b.ts']);
    expect(result.privileged).toBe(false);
    expect(result.ambiguous).toBe(false);
  });

  it('matches whole path segments, not substrings', () => {
    // `/etcd/conf` is not `/etc`; a substring rule would refuse ordinary work and teach
    // the operator to ignore the broker.
    const result = classifyIn(['cp', 'etcd/conf', 'src/b.ts']);
    expect(result.privileged).toBe(false);
    const absolute = classifyIn(['cp', '/etcd/conf', 'src/b.ts']);
    expect(absolute.privileged).toBe(false);
    expect(absolute.ambiguous).toBe(false);
  });
});

describe('the tokens a decision binds to', () => {
  it('hashes different operations differently', () => {
    expect(operationSha(classifyIn(['sudo', 'ls']))).not.toBe(
      operationSha(classifyIn(['sudo', 'rm', '-rf', '/'])),
    );
  });

  it('parses shell strings with quotes and operators', () => {
    expect(tokeniseShell('echo "a b" && sudo ls')).toEqual([
      ['echo', 'a b'],
      ['sudo', 'ls'],
    ]);
    expect(tokeniseShell(`sh -c 'x; y'`)).toEqual([['sh', '-c', 'x; y']]);
    expect(tokeniseShell('a\\ b c')).toEqual([['a b', 'c']]);
  });
});
