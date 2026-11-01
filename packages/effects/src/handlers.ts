/**
 * The handler contract — what an effect handler may assume, and what it may not.
 *
 * An effect handler is the only code in the factory that is allowed to touch the
 * outside world during dispatch: start an agent attempt, open a change request,
 * publish a promotion. It runs **after** the state change that produced it has
 * committed, which is what makes the outbox replay-safe without a replay engine
 * (`architecture.md` §2.1, rule R4).
 *
 * Two obligations come with that privilege:
 *
 *  1. **Idempotent by contract.** A handler must be safe to run twice with the
 *     same payload and must never assume it is the first run. The dispatcher
 *     records the outcome *after* the side effect, so a crash in that window
 *     re-delivers the effect on the next drain. That window cannot be closed
 *     without two-phase commit against the outside world, so the handler — not
 *     the ledger — is what absorbs it.
 *  2. **Validate what it is handed.** `payload` comes out of the outbox and is
 *     untrusted JSON: it was written by an earlier process, from a possibly
 *     older schema. Use `defineEffectHandler`'s `parse` seam (or your own guard)
 *     before touching it.
 */
import { FactoryError } from '@factory/contracts';

/** What the dispatcher tells a handler about the invocation it is serving. */
export interface EffectContext {
  readonly effectId: string;
  /**
   * 1-based invocation counter for this effect, as recorded in the outbox before
   * the handler ran. Retries of the same effect increment it; it is not a global
   * counter and it is not an attempt id.
   */
  readonly attempt: number;
}

export interface EffectHandler<TPayload = unknown> {
  readonly kind: string;
  /** Idempotent by contract: running twice with the same payload must be safe, and the handler MUST NOT assume it is the first run. */
  run(payload: TPayload, ctx: EffectContext): Promise<void>;
}

/**
 * Declare a handler.
 *
 * This exists for one reason: `EffectHandler`'s payload defaults to `unknown`, so
 * a handler that wants a *typed* payload cannot be passed to `EffectHandler[]`
 * directly (function parameters are contravariant under `strictFunctionTypes`).
 * Declaring through this helper restores that narrowing at the call site and
 * confines the unavoidable cast to this one function.
 *
 * The cast is a promise the helper cannot keep for you: the dispatcher will hand
 * the handler whatever JSON the outbox holds. Pass `parse` and the promise is
 * kept for you — a payload that does not parse becomes a recorded failure with a
 * readable reason instead of a handler operating on nonsense.
 *
 * @example
 * const launch = defineEffectHandler<LaunchPayload>({
 *   kind: 'launch-attempt',
 *   parse: (raw) => LaunchPayloadSchema.parse(raw),
 *   run: async (payload, ctx) => { ... },
 * });
 */
export function defineEffectHandler<TPayload>(spec: {
  readonly kind: string;
  readonly parse?: (payload: unknown) => TPayload;
  run(payload: TPayload, ctx: EffectContext): Promise<void>;
}): EffectHandler {
  const { kind, parse, run } = spec;
  if (parse === undefined) {
    return { kind, run } as unknown as EffectHandler;
  }
  return {
    kind,
    run: async (payload: unknown, ctx: EffectContext): Promise<void> => {
      await run(parse(payload), ctx);
    },
  };
}

/**
 * Route kinds to handlers, refusing ambiguity.
 *
 * Two handlers for one kind is not a configuration detail: it means an effect's
 * outcome depends on registration order, which is exactly the kind of hidden
 * non-determinism that lets a replay diverge. The dispatcher therefore refuses
 * to start rather than pick one.
 */
export function indexHandlers(
  handlers: readonly EffectHandler[],
): ReadonlyMap<string, EffectHandler> {
  const byKind = new Map<string, EffectHandler>();
  for (const handler of handlers) {
    if (handler.kind.trim() === '') {
      throw new FactoryError('INTERNAL', 'effects: a handler kind must be a non-empty string');
    }
    if (byKind.has(handler.kind)) {
      throw new FactoryError(
        'INTERNAL',
        `effects: duplicate handler for kind "${handler.kind}" — routing an effect to one of two handlers would make its outcome depend on registration order`,
        { kind: handler.kind },
      );
    }
    byKind.set(handler.kind, handler);
  }
  return byKind;
}
