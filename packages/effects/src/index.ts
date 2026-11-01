/**
 * `@factory/effects` — the outbox dispatcher.
 *
 * The engine commits state and its implied effects together; this package performs
 * those effects afterwards, at most once, keyed by content. Import surface:
 *
 * ```ts
 * import { createDispatcher, defineEffectHandler } from '@factory/effects';
 * ```
 *
 * The dispatcher never runs model calls or spawns work itself — it routes each
 * pending effect to the handler registered for its `kind`, and the handler is the
 * only place external I/O happens (`architecture.md` §2.1).
 */
export {
  CLAIM_PAGE_SIZE,
  createDispatcher,
  DEFAULT_MAX_ATTEMPTS,
  type ApplyKeyResult,
  type DispatcherOptions,
  type DrainSummary,
  type EffectDispatcher,
  type EffectStore,
} from './dispatcher.ts';

export {
  defineEffectHandler,
  indexHandlers,
  type EffectContext,
  type EffectHandler,
} from './handlers.ts';
