/**
 * `@factory/wall` — the verification plane.
 *
 * The one sentence this package exists to make true: the wall decides whether an
 * attempt is *actually* done, using evidence the agent could not have written, in
 * an environment the agent could not have touched, against scenarios the agent has
 * never seen.
 *
 * What it is not: safe. It is a deterministic, offline, model-free set of controls
 * that is *knowingly incomplete* — the oracle switch only implements `command`, the
 * weakening check catches deletion rather than rewrite, and a single holdout cannot
 * prove it covers the change. Two of those holes are now instrumented rather than
 * shrugged at: `holdout_not_discriminating` catches a holdout whose scenarios already
 * pass on the base revision, and `self-test` proves the wall can still fail.
 * The honest claim is the one in `README.md`: independent, deterministic where
 * possible, adversarially tested against itself, human-audited on a schedule.
 * Anything stronger would be a lie told by the thing that grades everything else.
 */
export {
  defaultHoldoutRoot,
  loadHoldout,
  assertHoldoutOutsideRepo,
  hashableScenarios,
  HOLDOUT_SAFE_SEGMENT,
  type HoldoutScenario,
  type HoldoutStore,
} from './holdout.ts';

export {
  evaluate,
  isDestructiveArgv,
  pathIsInScope,
  HOLDOUT_ABSENT_REVISION,
  NO_PATCH,
  type ChangedFile,
  type DiffInspector,
  type EvaluateInput,
  type ScenarioRunInput,
  type ScenarioRunResult,
  type ScenarioRunner,
} from './evaluate.ts';

export {
  oneLineReason,
  workerFacingReason,
  WORKER_FACING_ACCEPTANCE,
  WORKER_FACING_REFUSAL,
} from './reasons.ts';

export {
  criteriaLogPath,
  readCriteriaLog,
  recordRun,
  recordRuns,
  discrimination,
  assessDiscrimination,
  assertDiscriminating,
  createCriteriaLog,
  type CriteriaLogEntry,
  type CriteriaLogPort,
  type CriteriaLogReadResult,
  type DiscriminationReport,
  type ScenarioDiscrimination,
} from './criteria-log.ts';

export {
  defaultKeyDir,
  EVALUATOR_PRIVATE_KEY_FILE,
  EVALUATOR_PUBLIC_KEY_FILE,
  readKeyFile,
  generateSigningKeyPair,
  signVerdict,
  verifyVerdict,
  verdictSigningPayload,
} from './signing.ts';

export {
  createContainerRunner,
  dockerRunArgv,
  dockerIsAvailable,
  type ContainerRunnerOptions,
} from './container.ts';

export {
  createLocalRunner,
  parseSummary,
  SUMMARY_LINE_PREFIX,
  LocalRunnerRefusal,
  type LocalRunnerOptions,
} from './local.ts';

export {
  runSelfTest,
  loadCorpusCase,
  formatSelfTestReport,
  type SelfTestReport,
  type SelfTestCaseResult,
} from './selftest.ts';

export { main as cliMain, defaultCorpusDir } from './cli.ts';
export {
  certificateRecency,
  certificatesRecency,
  type CertificateRecency,
  type RunningCertificationBasis,
  type StoredCertificate,
} from './certificate-recency.ts';
export {
  binomialCdfAtMost,
  certificationAlpha,
  certificationForClass,
  DEFAULT_OPERATING_POINT,
  type CertificationOutcome,
  type ClassCertification,
  type OperatingPoint,
} from './operating-point.ts';
