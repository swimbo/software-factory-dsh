/**
 * Which task class a run is measured under — one derivation, two readers.
 *
 * The engine's dispatch gate reads a class **certificate** and the wall files its verdict under the
 * same class, so both must agree exactly; two copies of this rule in two files is how a store ends up
 * with a certificate no gate ever looks at.
 *
 * The spec has no `taskClass` field on purpose (the qualifier derives a class from measured history,
 * and v1's engine passes `unknown`), so the operator names the class with
 * `FACTORY_HOLDOUT_TASK_CLASS` and the spec slug is the default: units of the same kind share a slug
 * family.
 */
import type { UnitSpec } from '@factory/contracts';

export function taskClassFrom(
  env: Readonly<Record<string, string | undefined>>,
  spec: UnitSpec,
): string {
  const configured = (env.FACTORY_HOLDOUT_TASK_CLASS ?? '').trim();
  return configured === '' ? spec.slug : configured;
}
