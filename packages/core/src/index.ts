/**
 * `@factory/core` — the command layer.
 *
 * `rules.ts` is the pure algebra of dispatch (no store, no clock, no I/O);
 * `engine.ts` is the ordering that turns it into commands. Both are exported
 * together because a caller that wants "can this be dispatched?" and a caller
 * that wants "dispatch it" are the same caller.
 */
export * from './rules.ts';
export * from './engine.ts';
