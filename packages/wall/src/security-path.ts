/**
 * Security-relevant path classification, for the wall's receipt-time ladder.
 *
 * The pattern table is a **copy** of `packages/qualifier/src/security.ts` (A5.1), not an
 * import. Importing would need a workspace dependency edge and a lockfile mutation — a
 * repo-wide operation during a phase where three packages are being written at once —
 * and the Lead's ruling was to duplicate with the drift test as the condition of
 * acceptance. `drift.test.ts` reads the qualifier's source and fails if the two tables
 * diverge, so the duplication cannot rot silently; if the qualifier package is not
 * present the test skips, and the copy stands on its own.
 *
 * The wall uses it for a *different question* than the qualifier does. The qualifier asks
 * "is this unit security-relevant?" at qualify time and answers `lit`. The wall asks, at
 * receipt time, "did the diff touch something security-relevant that the unit did not
 * declare it would touch?" — a declared sensitive path is a planned, reviewed change; an
 * undeclared one is camouflage.
 */
import { pathIsInScope } from './scope.ts';

interface PathRule {
  readonly pattern: RegExp;
  readonly why: string;
}

/** Kept in the same order and with the same `why` strings as the qualifier's table. */
export const SENSITIVE_PATH_PATTERNS: readonly PathRule[] = [
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

/** Operation classes that are security-relevant by definition (same set as the qualifier). */
export const SENSITIVE_OPERATION_CLASSES: readonly string[] = [
  'credential-use',
  'network-egress',
  'schema-migration',
  'data-delete',
  'force-push',
];

export interface SensitivePath {
  readonly path: string;
  readonly why: string;
}

export interface SecurityPathAssessment {
  /** Sensitive paths in the diff that no declared touch path covers. This is the lockout. */
  readonly undeclared: readonly SensitivePath[];
  /** Sensitive paths the unit did declare: planned, reviewed, and therefore not a lockout by itself. */
  readonly declared: readonly SensitivePath[];
  /** Operation classes that are security-relevant even when reversible. */
  readonly sensitiveOperations: readonly string[];
  /** One operator-facing line. Names the path (the agent already knows it wrote it), never a scenario. */
  readonly detail: string;
}

function matchesAny(changedPath: string, declared: readonly string[]): boolean {
  return declared.some((scope) => pathIsInScope(changedPath, [scope]));
}

/**
 * Classify a diff against what the unit said it would touch.
 *
 * An empty input is not relevant: an unscoped unit is caught by the reversibility and
 * scope checks, not here.
 */
export function assessSecurityPaths(
  changedPaths: readonly string[],
  declaredTouchPaths: readonly string[],
  operationClasses: readonly string[] = [],
): SecurityPathAssessment {
  const undeclared: SensitivePath[] = [];
  const declared: SensitivePath[] = [];

  for (const changedPath of changedPaths) {
    for (const rule of SENSITIVE_PATH_PATTERNS) {
      if (!rule.pattern.test(changedPath)) continue;
      const hit: SensitivePath = { path: changedPath, why: rule.why };
      const bucket = matchesAny(changedPath, declaredTouchPaths) ? declared : undeclared;
      if (!bucket.some((entry) => entry.path === hit.path && entry.why === hit.why))
        bucket.push(hit);
    }
  }

  const sensitiveOperations = operationClasses.filter((operation) =>
    SENSITIVE_OPERATION_CLASSES.includes(operation),
  );

  const parts: string[] = [];
  for (const hit of undeclared) parts.push(`${hit.path} (${hit.why})`);
  if (sensitiveOperations.length > 0)
    parts.push(`operation class ${sensitiveOperations.join(', ')}`);

  return {
    undeclared,
    declared,
    sensitiveOperations,
    detail:
      parts.length === 0
        ? 'no undeclared security-relevant path'
        : `security-relevant and undeclared: ${parts.join('; ')}`,
  };
}
