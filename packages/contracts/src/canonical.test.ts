/**
 * The hash contract.
 *
 * Every identity in the factory — a spec, a receipt, a verdict, an idempotency
 * key — is derived from `canonicalJson`/`contentHash`/`idempotencyKey`. If key
 * order could change a hash, then "the same unit" would not be a computable
 * fact and replay would be a guess. These tests pin the two halves of that
 * promise: values that must hash identically, and values that must be refused
 * rather than silently coerced.
 */
import { describe, expect, it } from 'vitest';
import { canonicalJson, contentHash, idempotencyKey, sha256Hex } from './canonical.ts';

const HASH_FORM = /^sha256:[0-9a-f]{64}$/;
const DIGEST_FORM = /^[0-9a-f]{64}$/;

describe('canonicalJson', () => {
  it('sorts object keys, so key order cannot change the hash', () => {
    expect(canonicalJson({ a: 1, b: 2 })).toBe(canonicalJson({ b: 2, a: 1 }));
  });

  it('emits no whitespace, so formatting cannot change the hash', () => {
    expect(canonicalJson({ a: 1, b: [1, 2] })).toBe('{"a":1,"b":[1,2]}');
  });

  it('canonicalises nested objects and the objects inside arrays', () => {
    expect(canonicalJson({ z: [{ b: 1, a: 2 }], a: { d: 4, c: 3 } })).toBe(
      '{"a":{"c":3,"d":4},"z":[{"a":2,"b":1}]}',
    );
  });

  it('preserves array order, because an array is a sequence and not a set', () => {
    expect(canonicalJson([2, 1])).not.toBe(canonicalJson([1, 2]));
  });

  it('keeps an explicit null, which is a value the operator wrote', () => {
    expect(canonicalJson({ a: null })).toBe('{"a":null}');
  });

  it('drops keys whose value is undefined', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
  });

  it('refuses a bare undefined rather than hashing it as null', () => {
    expect(() => canonicalJson(undefined)).toThrow(TypeError);
  });

  it('refuses undefined inside an array: objects drop keys, arrays cannot drop slots', () => {
    expect(() => canonicalJson([undefined])).toThrow(TypeError);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    'refuses the non-finite number %s',
    (value) => {
      expect(() => canonicalJson({ value })).toThrow(TypeError);
    },
  );

  it('refuses a Date instead of inventing a serialisation for it', () => {
    expect(() => canonicalJson({ at: new Date('2026-11-01T00:00:00.000Z') })).toThrow(
      /Date is not hashable/,
    );
  });

  it('refuses a class instance: only plain objects are hashable', () => {
    class Point {
      readonly x = 1;
    }
    expect(() => canonicalJson({ point: new Point() })).toThrow(/only plain objects/);
  });

  it('refuses values JSON would drop or coerce (functions, bigints)', () => {
    expect(() => canonicalJson({ fn: () => 1 })).toThrow(/unsupported type/);
    expect(() => canonicalJson({ big: 1n })).toThrow(/unsupported type/);
  });
});

describe('contentHash', () => {
  it('is an algorithm-prefixed sha256 over 64 lowercase hex digits', () => {
    expect(contentHash({ a: 1 })).toMatch(HASH_FORM);
  });

  it('is stable across key order: the same content is the same hash', () => {
    expect(contentHash({ a: 1, b: [2, 3] })).toBe(contentHash({ b: [2, 3], a: 1 }));
  });

  it('changes when a single value changes', () => {
    expect(contentHash({ a: 1 })).not.toBe(contentHash({ a: 2 }));
  });

  it('is the prefix plus sha256Hex of the canonical form, with nothing in between', () => {
    const value = { unitId: 'U-1', delta: 0.1 };
    expect(contentHash(value)).toBe(`sha256:${sha256Hex(canonicalJson(value))}`);
    expect(sha256Hex(canonicalJson(value))).toMatch(DIGEST_FORM);
  });
});

describe('idempotencyKey', () => {
  it('is namespaced, so two kinds of effect cannot collide on identical inputs', () => {
    const dispatch = idempotencyKey('dispatch', { attemptId: 'A-1' });
    const verify = idempotencyKey('verify', { attemptId: 'A-1' });
    expect(dispatch.startsWith('dispatch:')).toBe(true);
    expect(dispatch.slice('dispatch:'.length)).toMatch(DIGEST_FORM);
    expect(verify).not.toBe(dispatch);
  });

  it('is deterministic for the same inputs, so a retry reuses the key', () => {
    expect(idempotencyKey('dispatch', { a: 1, b: 2 })).toBe(
      idempotencyKey('dispatch', { b: 2, a: 1 }),
    );
  });

  it('rejects a namespace that is not lower-kebab', () => {
    expect(() => idempotencyKey('Bad_NS', { a: 1 })).toThrow(/bad namespace/);
  });
});
