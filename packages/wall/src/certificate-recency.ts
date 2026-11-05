/**
 * Is a stored class certificate current, or has the ground it stood on moved?
 *
 * A certificate is a statement "this class, at this operating point, under this policy version, this
 * model id and this corpus, met k of m". Three of those inputs are world-state: change the policy (so
 * the operating point or the wall's rules change), change the model, or change the corpus the class is
 * measured against (a holdout can gain a rule — that is what happened when `test-repair` went from two
 * rules to three), and the old measurement no longer describes the thing being shipped. The judgement
 * is therefore not "is the record valid" — it always is, it is history — but "may it still be used to
 * claim this class is fine today".
 *
 * The corpus is compared the way the policy version is: against the newest measurement this class
 * wrote, with older-but-attributed rows as a bounded fallback. It is **not** compared against a
 * running corpus from the environment, because an audit that read the operator's `FACTORY_HOLDOUT_ROOT`
 * would let the same store answer differently from two shells — the ledger is the evidence, and the
 * corpus a certificate names is read from the ledger.
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
  /**
   * The corpus the certificate was measured against, when the row names one. `null` (or absent, for a
   * row written before schema v5) means "this certificate predates corpus attribution": it is stale,
   * because there is no way to prove which evidence it describes — never current by wildcard.
   */
  readonly holdoutRevision?: string | null;
  readonly recordedAt: string;
}

/** What the running factory would certify under right now. */
export interface RunningCertificationBasis {
  readonly policyVersion: string;
  /** `null` when the running factory is offline: there is then no model to compare against. */
  readonly modelId: string | null;
  /**
   * Additional digests that also mean "these rules", produced by earlier projections of the
   * policy that are no longer current. A stored certificate whose `policyVersion` is one of
   * these was measured under the *same rules* and a different (now-irrelevant) input — the
   * dispatch ceilings that used to live on the policy object — so it is current, not stale.
   * Built by `@factory/qualifier`'s `legacyPolicyVersions`.
   */
  readonly acceptedPolicyVersions?: ReadonlySet<string>;
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
      /**
       * The corpus the class was last measured under, when any of its rows names one. The audit
       * prints it beside the certificate's own corpus so the disagreement is legible; `null` means no
       * measurement of this class has ever named a corpus.
       */
      readonly referenceHoldoutRevision: string | null;
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
 * The stored row a judgement is made from.
 *
 * A class keeps every certificate it ever wrote. Once it has been certified, a *newer* attempt that
 * measured less evidence (a fresh count after a policy change, or a run that failed) writes an
 * `insufficient` or `not-certified` row — and that row does not un-certify the class, so the row the
 * judgement names is the newest `certified` one. Before any certification exists, the newest row is
 * the best record there is.
 *
 * Exported because a caller that prints counts beside a state must print the counts of *this* row;
 * re-deriving the rule at the call site is how the display and the state drift apart.
 */
export function judgedCertificate<T extends StoredCertificate>(
  certificates: readonly T[],
): T | undefined {
  return certificates.find((certificate) => certificate.outcome === 'certified') ?? certificates[0];
}

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
  const judged = judgedCertificate(input.certificates);
  if (latest === undefined || certified === undefined || judged === undefined) {
    return {
      taskClass: input.taskClass,
      state: 'never-certified',
      certificate: judged ?? null,
    };
  }

  const reasons: string[] = [];
  const accepted = input.running.acceptedPolicyVersions;
  const sameRules =
    certified.policyVersion === input.running.policyVersion ||
    (accepted !== undefined && accepted.has(certified.policyVersion));
  if (!sameRules) {
    reasons.push(
      `re-certify: policy changed (certified under ${certified.policyVersion}, running ${input.running.policyVersion})`,
    );
  }
  // A null on either side is "cannot prove it is current", never "unchanged": the model id is the
  // one input whose absence would otherwise silently widen a certificate to cover a model swap.
  // The corpus is the third world-state input. Compared against the newest measurement of *this
  // class* that names one — a row written before v5 names nothing, so the search walks past it rather
  // than concluding the class has no corpus at all. A null on the certificate's side is stale with a
  // reason that says why: treating it as a wildcard is the silent attribution this dimension exists
  // to stop, and it would put every pre-v5 certificate back to `current` forever.
  const referenceCorpus =
    input.certificates.find((certificate) => (certificate.holdoutRevision ?? null) !== null)
      ?.holdoutRevision ?? null;
  const certifiedCorpus = certified.holdoutRevision ?? null;
  if (certifiedCorpus === null) {
    reasons.push(
      referenceCorpus === null
        ? 're-certify: corpus unknown (this certificate predates corpus attribution; no measurement of this class names one)'
        : `re-certify: corpus unknown (this certificate predates corpus attribution; latest measurement under ${referenceCorpus})`,
    );
  } else if (referenceCorpus !== null && certifiedCorpus !== referenceCorpus) {
    reasons.push(
      `re-certify: corpus changed (certified under ${certifiedCorpus}, latest measurement under ${referenceCorpus})`,
    );
  }
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
      certificate: judged,
      reasons,
      referenceHoldoutRevision: referenceCorpus,
    };
  }
  return { taskClass: input.taskClass, state: 'current', certificate: judged };
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
