/**
 * Is a stored class certificate current, or has the ground it stood on moved?
 *
 * A certificate is a statement "this class, at this operating point, under this policy version and
 * this model id, met k of m". Two of those inputs are world-state: change the policy (so the
 * operating point or the wall's rules change) or change the model, and the old measurement no
 * longer describes the thing being shipped. The judgement is therefore not "is the record valid" —
 * it always is, it is history — but "may it still be used to claim this class is fine today".
 *
 * The function lives in the wall rather than the store because it is a judgement about wall
 * evidence, not a query: the store's job is to hand over rows, and a store that decided staleness
 * would put policy in the persistence layer, where the audit could not test it.
 *
 * `never-certified` is not a softer `stale`. L3: an absence of evidence is not evidence of absence,
 * and a class that was never certified cannot be current — not with a warning, not by ignoring it.
 */

/** The minimum a stored certificate must expose to be judged. Deliberately structural. */
export interface StoredCertificate {
  readonly taskClass: string;
  readonly outcome: 'certified' | 'not-certified' | 'insufficient';
  readonly policyVersion: string;
  /** `null` means the attempt did not say which model produced it — unknown, never "unchanged". */
  readonly modelId: string | null;
  readonly recordedAt: string;
}

/** What the running factory would certify under right now. */
export interface RunningCertificationBasis {
  readonly policyVersion: string;
  /** `null` when the running factory is offline: there is then no model to compare against. */
  readonly modelId: string | null;
}

export type CertificateRecency =
  | {
      readonly taskClass: string;
      readonly state: 'current';
      readonly certificate: StoredCertificate;
    }
  | {
      readonly taskClass: string;
      readonly state: 'stale';
      readonly certificate: StoredCertificate;
      /** Why it expired, in the audit's own words: these strings are printed verbatim. */
      readonly reasons: readonly string[];
    }
  | {
      readonly taskClass: string;
      readonly state: 'never-certified';
      /**
       * The best record that exists for the class, when one does — an `insufficient` or
       * `not-certified` certificate is a *reason* there is no current certification, and printing
       * its counts is more honest than printing nothing at all.
       */
      readonly certificate: StoredCertificate | null;
    };

/**
 * Judge one class's stored certificates against the running basis.
 *
 * Only a `certified` certificate can ever be `current`; a `not-certified` or `insufficient` record
 * is treated as never-certified, and says so rather than reporting a stale pass. A class with no
 * records at all is `never-certified` — the cold-start hole this whole mechanism exists to close.
 */
export function certificateRecency(input: {
  readonly taskClass: string;
  /** Stored certificates for this class, newest first as the store returns them. */
  readonly certificates: readonly StoredCertificate[];
  readonly running: RunningCertificationBasis;
}): CertificateRecency {
  const [latest] = input.certificates;
  const certified = input.certificates.find((certificate) => certificate.outcome === 'certified');
  if (latest === undefined || certified === undefined) {
    return {
      taskClass: input.taskClass,
      state: 'never-certified',
      certificate: latest ?? null,
    };
  }

  const reasons: string[] = [];
  if (certified.policyVersion !== input.running.policyVersion) {
    reasons.push(
      `re-certify: policy changed (certified under ${certified.policyVersion}, running ${input.running.policyVersion})`,
    );
  }
  // A null on either side is "cannot prove it is current", never "unchanged": the model id is the
  // one input whose absence would otherwise silently widen a certificate to cover a model swap.
  if (input.running.modelId !== null) {
    if (certified.modelId === null) {
      reasons.push(
        `re-certify: model unknown (certified under an unrecorded model, running ${input.running.modelId})`,
      );
    } else if (certified.modelId !== input.running.modelId) {
      reasons.push(
        `re-certify: model changed (certified under ${certified.modelId}, running ${input.running.modelId})`,
      );
    }
  }
  if (reasons.length > 0) {
    return {
      taskClass: input.taskClass,
      state: 'stale',
      certificate: certified,
      reasons,
    };
  }
  return { taskClass: input.taskClass, state: 'current', certificate: certified };
}

/** Judge every class the store knows a certificate for. Order is the store's, so it is stable. */
export function certificatesRecency(input: {
  readonly byClass: ReadonlyMap<string, readonly StoredCertificate[]>;
  readonly running: RunningCertificationBasis;
}): readonly CertificateRecency[] {
  const classes = [...input.byClass.keys()].sort((left, right) => left.localeCompare(right));
  return classes.map((taskClass) =>
    certificateRecency({
      taskClass,
      certificates: input.byClass.get(taskClass) ?? [],
      running: input.running,
    }),
  );
}
