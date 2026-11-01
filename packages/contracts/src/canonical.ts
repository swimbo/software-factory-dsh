/**
 * Canonical hashing. Every identity in the factory is derived from one of these
 * two functions, so that "the same thing" is a single computable fact rather
 * than a convention. Determinism matters more than speed here: a hash that
 * changes between runs breaks receipts, idempotency keys and replay.
 */
import { createHash } from 'node:crypto';

/**
 * JSON with sorted object keys, no whitespace, and stable handling of the
 * values we actually store (strings, numbers, booleans, null, arrays, plain
 * objects). Anything else is refused rather than silently coerced: a hash over
 * a coerced value is a hash over something the operator never wrote.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (value === null) return null;
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return value;
    case 'number':
      if (!Number.isFinite(value)) {
        throw new TypeError(`canonicalJson: non-finite number ${String(value)} is not hashable`);
      }
      return value;
    case 'undefined':
      throw new TypeError('canonicalJson: undefined is not hashable (use null explicitly)');
    case 'object':
      break;
    default:
      throw new TypeError(`canonicalJson: unsupported type ${typeof value}`);
  }
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value instanceof Date) {
    throw new TypeError('canonicalJson: Date is not hashable (store ISO strings)');
  }
  const proto: unknown = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    throw new TypeError('canonicalJson: only plain objects are hashable');
  }
  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort()) {
    if (source[key] === undefined) continue;
    out[key] = canonicalize(source[key]);
  }
  return out;
}

export function sha256Hex(input: string | Uint8Array): string {
  return createHash('sha256').update(input).digest('hex');
}

/** The hash form stored in the ledger: algorithm-prefixed, so it can never be mistaken for a raw digest. */
export function contentHash(value: unknown): string {
  return `sha256:${sha256Hex(canonicalJson(value))}`;
}

/** Idempotency keys are content hashes with a namespace prefix; the prefix is what keeps two kinds of effect apart. */
export function idempotencyKey(namespace: string, value: unknown): string {
  if (!/^[a-z][a-z0-9-]*$/.test(namespace)) {
    throw new TypeError(`idempotencyKey: bad namespace ${namespace}`);
  }
  return `${namespace}:${sha256Hex(canonicalJson(value))}`;
}
