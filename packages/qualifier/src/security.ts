/**
 * Security relevance — the lane lock.
 *
 * The Phase 5 debate (amendment A5) established one rule that outranks the score:
 * **a security-relevant change never goes dark**, even when it is behaviour-
 * preserving and every other signal passes. The reason is not that such changes are
 * always risky; it is that the failure mode is silent and the wall's instruments
 * (holdout pass rate, Δ) are structurally blind to it — a change that removes a
 * length check can keep every test green forever.
 *
 * Two deliberate design choices:
 *
 *  1. It is a **lock, not a seventh weighted signal**. A weighted signal can be
 *     outvoted by six passing ones (that is what `darkThreshold` means); a lock
 *     cannot. `architecture.md` §2.4 records this as the implemented form of A5.
 *  2. The classifier is **path- and shape-based only** — no model, no heuristics we
 *     cannot explain. A false positive costs a human's attention; a false negative
 *     costs the property. So the patterns lean broad, and the operator-facing reason
 *     says which pattern fired.
 */

export interface SecuritySignals {
  /** Paths the unit declares it will touch. */
  readonly touchPaths: readonly string[];
  /** Paths the attempt actually changed, when the receipt is available (the receipt-time check). */
  readonly changedPaths?: readonly string[];
  /** Operation classes from the spec, which can imply privilege even on a benign path. */
  readonly operationClasses?: readonly string[];
}

export interface SecurityRelevance {
  readonly relevant: boolean;
  /** Which rule fired, quoted in the operator line. Empty when not relevant. */
  readonly reasons: readonly string[];
}

/** Path prefixes that make a change security-relevant wherever they appear. */
const SENSITIVE_PATH_PATTERNS: ReadonlyArray<{ readonly pattern: RegExp; readonly why: string }> = [
  {
    pattern: /(^|\/)(\.env|\.env\..*|.*\.pem|.*\.key|.*\.p12|.*\.jks)$/i,
    why: 'credential or key material',
  },
  {
    pattern: /(^|\/)(auth|authz|oauth|saml|login|session|rbac|acl|permissions?)(\/|\.|$)/i,
    why: 'authentication or authorisation code',
  },
  {
    pattern: /(^|\/)(crypto|tls|ssl|certificate|certificates)(\/|\.|$)/i,
    why: 'cryptography or transport security',
  },
  {
    pattern: /(^|\/)(Dockerfile|docker-compose.*\.ya?ml|\.dockerignore)$/i,
    why: 'container build surface',
  },
  { pattern: /(^|\/)\.github\/workflows\//i, why: 'CI workflow (can exfiltrate secrets)' },
  {
    pattern: /(^|\/)(Makefile|\.npmrc|\.yarnrc.*|pnpm-workspace\.yaml)$/i,
    why: 'build or registry configuration',
  },
  {
    pattern: /(^|\/)(package\.json|pnpm-lock\.yaml|package-lock\.json|yarn\.lock)$/i,
    why: 'dependency manifest (supply chain)',
  },
  { pattern: /(^|\/)(migrations?|schema\.sql|.*\.sql)$/i, why: 'data definition or migration' },
  {
    pattern: /(^|\/)(sandbox|sandbox-policy|permissions?|policy)(\/|\.|$)/i,
    why: 'sandbox or policy definition',
  },
  { pattern: /(^|\/)(\.factory|holdout)(\/|$)/i, why: 'factory control surface' },
];

/** Operation classes that are security-relevant by definition. */
const SENSITIVE_OPERATION_CLASSES: ReadonlySet<string> = new Set([
  'credential-use',
  'network-egress',
  'schema-migration',
  'data-delete',
  'force-push',
]);

/**
 * Classify a unit (at qualify time) or a diff (at receipt time). Pure and total:
 * the same input always yields the same answer, and an empty input is *not*
 * relevant — an unscoped unit is caught by the reversibility signal, not here.
 */
export function classifySecurityRelevance(signals: SecuritySignals): SecurityRelevance {
  const reasons: string[] = [];
  const paths = [...signals.touchPaths, ...(signals.changedPaths ?? [])];

  for (const candidate of paths) {
    for (const rule of SENSITIVE_PATH_PATTERNS) {
      if (rule.pattern.test(candidate)) {
        const line = `${candidate} touches ${rule.why}`;
        if (!reasons.includes(line)) reasons.push(line);
      }
    }
  }

  for (const operation of signals.operationClasses ?? []) {
    if (SENSITIVE_OPERATION_CLASSES.has(operation)) {
      // Deliberately separate from the reversibility signal: `network-egress` is
      // reversible and still requires a human, because it can move data out.
      const line = `operation class ${operation} is security-relevant even when reversible`;
      if (!reasons.includes(line)) reasons.push(line);
    }
  }

  return { relevant: reasons.length > 0, reasons };
}

/** The one-line operator explanation, printed by `factory qualify`. */
export function securityRelevanceLine(relevance: SecurityRelevance): string {
  if (!relevance.relevant) return 'not security-relevant';
  return `security-relevant (locked to lit): ${relevance.reasons.join('; ')}`;
}
