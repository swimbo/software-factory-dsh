/**
 * The brokered-operation table: what the proxy is willing to have an opinion about.
 *
 * Every entry is a **normalised argv shape**, never a substring of a command line. The
 * difference is the whole point: `/\bsudo\b/` matches `echo "sudo is not installed"`, and
 * a denylist of words is what the incident corpus shows agents routing around. So the
 * table matches on `argv[0]`'s basename (after the wrapper unwrapping in `classify.ts`)
 * plus, where the tool has subcommands, an exact subcommand.
 *
 * ## What is deliberately *not* here
 *
 * - **No generic "any write outside the worktree" rule.** The broker's job is a small
 *   number of claims it can actually keep; "nothing may write outside the worktree" is
 *   the sandbox's claim, and a broker that half-implements it would be trusted for it.
 * - **No `git`-level rules.** `force-push` and the other destructive-verb classes are the
 *   wall's post-hoc check (`packages/wall/src/evaluate.ts`) and the qualifier's
 *   `operationClasses`; duplicating them here would create two answers to one question.
 * - **No `pip`/`npm`/`cargo` install rules.** An install inside the attempt clone is
 *   ordinary work; an install into a shared prefix is a `privileged` write to a path, and
 *   that is caught by the path rule, not by a package-manager rule.
 * - **No network-egress rules.** `packages/proxy` sees argv, not sockets. That claim
 *   belongs to the sandbox, and pretending otherwise would make the broker sound like
 *   containment.
 * - **`sudo`'s own flag forms are not enumerated.** `sudo -u root`, `sudo -E`, `sudo --`
 *   are all `sudo`: the binary itself is the class. Enumerating flags is the same trap as
 *   growing a denylist.
 */
import type { OperationClass } from '../../contracts/src/index.ts';

/**
 * The brokered classes. Each one maps onto a contract `OperationClass` so a brokered
 * operation and a declared unit can be compared with the same vocabulary.
 */
export const BROKERED_CLASSES = ['sudo', 'container', 'ci', 'cloud', 'macos-security', 'path-write'] as const;
export type BrokeredClass = (typeof BROKERED_CLASSES)[number];

/** What an operation class means for the contract. */
export const CLASS_TO_OPERATION_CLASS: Readonly<Record<BrokeredClass, OperationClass>> =
  {
    sudo: 'privileged',
    container: 'privileged',
    ci: 'privileged',
    cloud: 'privileged',
    'macos-security': 'privileged',
    'path-write': 'privileged',
  };

export interface OperationRule {
  /** Stable id. Appears in the audit trail, so it is never renamed. */
  readonly id: string;
  readonly brokeredClass: BrokeredClass;
  /** Basename of `argv[0]`, after wrapper unwrapping. */
  readonly binary: string;
  /** Exact subcommand match, where the tool has subcommands that differ in blast radius. */
  readonly subcommands?: readonly string[];
  /** One sentence for the operator: what this rule saw. */
  readonly describes: string;
}

/**
 * The initial classes named by the plan, plus the two that are the same operation wearing
 * another name (`doas` is sudo, `podman` is docker). One rule per *operation*, not per
 * product: a table of fifty product names would be a denylist again.
 */
export const OPERATION_RULES: readonly OperationRule[] = [
  {
    id: 'sudo.exec',
    brokeredClass: 'sudo',
    binary: 'sudo',
    describes: 'sudo runs a command as another user; the escalation is the operation',
  },
  {
    id: 'sudo.doas',
    brokeredClass: 'sudo',
    binary: 'doas',
    describes: 'doas runs a command as another user, like sudo',
  },
  {
    id: 'container.docker',
    brokeredClass: 'container',
    binary: 'docker',
    describes: 'docker can mount the host filesystem and run as root on the host',
  },
  {
    id: 'container.podman',
    brokeredClass: 'container',
    binary: 'podman',
    describes: 'podman can mount the host filesystem and run as root on the host',
  },
  {
    id: 'ci.gh',
    brokeredClass: 'ci',
    binary: 'gh',
    describes: 'gh mutates remote repositories and CI state outside the attempt clone',
  },
  {
    id: 'cloud.kubectl',
    brokeredClass: 'cloud',
    binary: 'kubectl',
    describes: 'kubectl changes a live cluster, which no verdict can roll back',
  },
  {
    id: 'cloud.aws',
    brokeredClass: 'cloud',
    binary: 'aws',
    describes: 'aws changes live cloud resources',
  },
  {
    id: 'cloud.gcloud',
    brokeredClass: 'cloud',
    binary: 'gcloud',
    describes: 'gcloud changes live cloud resources',
  },
  {
    id: 'macos-security.security',
    brokeredClass: 'macos-security',
    binary: 'security',
    describes: 'security reads and writes the keychain, including credentials',
  },
  {
    id: 'macos-security.defaults-write',
    brokeredClass: 'macos-security',
    binary: 'defaults',
    subcommands: ['write'],
    describes: 'defaults write changes system and application preferences',
  },
  {
    id: 'macos-security.launchctl',
    brokeredClass: 'macos-security',
    binary: 'launchctl',
    describes: 'launchctl loads and unloads system services',
  },
];

/**
 * The binaries whose argv can *write* a target path. Separate from `OPERATION_RULES`
 * because the rule is not "the binary is privileged" but "the binary names a privileged
 * path": `cp a b` in the worktree is ordinary, `cp x /etc/hosts` is not.
 */
export const PATH_WRITER_BINARIES: readonly string[] = [
  'cp',
  'mv',
  'install',
  'ln',
  'rm',
  'truncate',
  'tee',
  'dd',
  'chmod',
  'chown',
  'chgrp',
  'sed',
  'perl',
  'cat',
  'touch',
  'mkdir',
  'rsync',
  'scp',
  'curl',
  'wget',
];

/**
 * The privileged path prefixes. `~` and `$HOME` are normalised to the home directory
 * before this is consulted, so the table does not need a variant per spelling.
 *
 * `/var/root` is macOS's real root home; `/root` is Linux's. Both are here because the
 * broker may run on either and a rule that only knows one platform's spelling is a rule
 * that silently allows the other.
 */
export const PRIVILEGED_PATH_PREFIXES: readonly string[] = [
  '/etc',
  '/private/etc',
  '/root',
  '/var/root',
  '/usr/local/bin',
  '/usr/bin',
  '/System',
  '/Library/LaunchDaemons',
  '/Library/LaunchAgents',
  '/boot',
  '.ssh',
  '.aws',
  '.config/gh',
  '.kube',
  '.docker',
  '.gnupg',
];

export function ruleFor(binary: string, argv: readonly string[]): OperationRule | null {
  for (const rule of OPERATION_RULES) {
    if (rule.binary !== binary) continue;
    if (rule.subcommands === undefined) return rule;
    const subcommand = argv[1];
    if (subcommand !== undefined && rule.subcommands.includes(subcommand)) return rule;
  }
  return null;
}

/**
 * True when a word names a privileged path.
 *
 * A *path segment* match, not a substring: `/etcd/conf` is not `/etc`, and a rule that
 * said it was would refuse ordinary work until an operator started ignoring the broker.
 */
export function isPrivilegedPath(word: string, home: string | null): boolean {
  const candidates = [word, `/${word}`];
  for (const prefix of PRIVILEGED_PATH_PREFIXES) {
    if (!prefix.startsWith('/')) continue;
    for (const candidate of candidates) {
      if (candidate === prefix || candidate.startsWith(`${prefix}/`)) return true;
    }
  }
  if (home === null) return false;
  for (const relative of PRIVILEGED_PATH_PREFIXES) {
    if (relative.startsWith('/')) continue;
    const absolute = `${home.replace(/\/+$/u, '')}/${relative}`;
    if (word === absolute || word.startsWith(`${absolute}/`)) return true;
  }
  return false;
}
