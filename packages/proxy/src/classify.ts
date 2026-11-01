/**
 * The post-expansion classifier: what an argv *means*, not what it says.
 *
 * The denylist in `packages/wall/src/evaluate.ts` matches patterns against a joined
 * command line, and its own comment admits it is partial. This module exists because the
 * hole is structural, not lexical: an agent that writes `sh -c "sudo …"` has not written
 * a command containing the word `sudo` in any position a regex over `argv.join(' ')`
 * would recognise — and every wrapper below (`env`, `xargs`, `nice`, `timeout`, `sudo -u`,
 * a path-qualified `/usr/bin/sudo`) is the same evasion with a different spelling.
 *
 * So classification happens **after expansion**:
 *
 * 1. **Shell strings are parsed, not trusted.** `sh -c '<string>'`, `bash -c`, `zsh -c`,
 *    `dash -c`, `ksh -c`, `eval '<string>'` and `xargs sh -c '<string>'` have their string
 *    tokenised (quotes, backslash escapes, `;`, `&&`, `||`, `|`, `&`, newlines) into
 *    *segments*, and every segment is classified. One privileged segment makes the whole
 *    operation privileged, because the shell will run all of them.
 * 2. **Wrappers are unwrapped recursively.** `env` (skipping `VAR=value` and flags),
 *    `command`, `builtin`, `exec`, `nohup`, `nice [-n N]`, `ionice [-c N]`, `stdbuf [-o…]`,
 *    `timeout <duration> [flags]`, `xargs [flags]`. A wrapper is never the operation.
 * 3. **Binaries are resolved to their basename.** `/usr/bin/sudo` and `sudo` are the same
 *    operation; `./sudo` too. Without this, a path prefix is a bypass.
 * 4. **Paths are normalised** (`~`, `$HOME`, trailing slashes) before being compared to
 *    the privileged-prefix table, segment-wise: `/etcd/conf` is not `/etc`.
 * 5. **Dynamic words in the command position are *ambiguous*, never allowed.** `$X rm`,
 *    `$(which sudo) ls`, `` `whoami` `` — the broker cannot know what they expand to, and
 *    unknown is not pass (L3). Ambiguity is a refusal, not a warning.
 *
 * The output hashes the **normalised segments**, which is what binds a human decision to
 * one exact operation: `/usr/bin/sudo ls` and `sudo ls` hash the same, `sudo ls` and
 * `sudo rm -rf /` do not.
 */
import { contentHash, type OperationClass } from '../../contracts/src/index.ts';

import {
  CLASS_TO_OPERATION_CLASS,
  isPrivilegedPath,
  PATH_WRITER_BINARIES,
  ruleFor,
  type BrokeredClass,
} from './operations.ts';

/** Wrappers that run another command; each contributes no operation of its own. */
const WRAPPERS = new Set([
  'env',
  'command',
  'builtin',
  'exec',
  'nohup',
  'nice',
  'ionice',
  'stdbuf',
  'timeout',
  'xargs',
]);

/** Shells whose `-c` argument is a script, not a filename. */
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'ash']);

/** Wrapper flags that take a value in the next word (`env -u NAME`, `timeout -s SIG`). */
const WRAPPER_FLAGS_WITH_VALUE: Readonly<Record<string, readonly string[]>> = {
  env: ['-u', '--unset', '-C', '--chdir', '-S', '--split-string'],
  nice: ['-n', '--adjustment'],
  ionice: ['-c', '--class', '-n', '--classdata'],
  stdbuf: ['-i', '-o', '-e'],
  timeout: ['-s', '--signal', '-k', '--kill-after'],
  xargs: ['-n', '--max-args', '-I', '-P', '--max-procs', '-L', '-s', '-E', '-d', '--delimiter'],
};

export interface ClassifiedSegment {
  /** The words the shell will actually run, after wrappers and basenames. */
  readonly words: readonly string[];
  /** True when the first word is a dynamic expansion the broker cannot resolve. */
  readonly dynamic: boolean;
}

export interface Classification {
  /** The contract's vocabulary. `privileged` is the broker's class. */
  readonly operationClass: OperationClass;
  readonly privileged: boolean;
  /** Fail-closed when true: an operation nobody can prove safe is a human's decision. */
  readonly ambiguous: boolean;
  /** Stable rule id (`sudo.exec`, `path-write:/etc`, `ambiguous.dynamic-word`), null if none. */
  readonly ruleId: string | null;
  readonly brokeredClass: BrokeredClass | null;
  /** Every segment, post-expansion. This is what a `GateDecision` binds to. */
  readonly segments: readonly ClassifiedSegment[];
  /** One sentence, printable: what the classifier did. */
  readonly detail: string;
}

const isFlag = (word: string): boolean => word.startsWith('-');

/** The path a `>`/`>>` redirection writes, or `null` when there is no redirection. */
function redirectTargetOf(words: readonly string[], home: string | null): string | null {
  for (const [index, word] of words.entries()) {
    const attached = /^>>?(.+)$/u.exec(word);
    if (attached !== null) {
      const target = attached[1] ?? '';
      // `2>&1` is a descriptor duplication, not a file write.
      if (target.startsWith('&')) continue;
      return normaliseWord(target, home);
    }
    if (word === '>' || word === '>>') {
      const next = words[index + 1];
      if (next === undefined || next.startsWith('&')) continue;
      return normaliseWord(next, home);
    }
  }
  return null;
}
const isAssignment = (word: string): boolean => /^[A-Za-z_][A-Za-z0-9_]*=/u.test(word);

/** `$X`, `$(cmd)`, `` `cmd` `` — anything the broker cannot resolve without running it. */
function isDynamic(word: string): boolean {
  return /\$\(|`|\$\{|\$[A-Za-z_]/u.test(word);
}

/**
 * Split a shell script into segments, respecting quotes and backslash escapes.
 *
 * Deliberately not a POSIX shell parser: it does not need to be, because the broker never
 * *executes* the string. It needs to be conservative in one direction only — if it cannot
 * tell where a command starts, the segment's first word becomes suspicious and the
 * operation is refused as ambiguous.
 */
export function tokeniseShell(script: string): string[][] {
  const segments: string[][] = [];
  let current: string[] = [];
  let word = '';
  let inWord = false;
  let quote: '"' | "'" | null = null;
  let escaped = false;

  const endWord = (): void => {
    if (!inWord) return;
    current.push(word);
    word = '';
    inWord = false;
  };
  const endSegment = (): void => {
    endWord();
    if (current.length > 0) segments.push(current);
    current = [];
  };

  for (const char of script) {
    if (escaped) {
      word += char;
      inWord = true;
      escaped = false;
      continue;
    }
    if (char === '\\' && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote !== null) {
      if (char === quote) {
        quote = null;
        continue;
      }
      word += char;
      inWord = true;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      inWord = true; // an empty quoted string is still an (empty) word
      continue;
    }
    if (char === ';' || char === '&' || char === '|' || char === '\n') {
      endSegment();
      continue;
    }
    if (char === ' ' || char === '\t' || char === '\r') {
      endWord();
      continue;
    }
    word += char;
    inWord = true;
  }
  endSegment();
  return segments;
}

/** `sudo` in any path spelling, and `~`/`$HOME` normalised to the real home. */
function normaliseWord(word: string, home: string | null): string {
  if (home !== null) {
    if (word === '~') return home;
    if (word.startsWith('~/')) return `${home.replace(/\/+$/u, '')}/${word.slice(2)}`;
  }
  if (word === '$HOME') return home ?? word;
  if (word.startsWith('$HOME/')) return `${home ?? '$HOME'}/${word.slice(6)}`;
  return word;
}

function basename(word: string): string {
  const withoutPath = word.includes('/') ? word.slice(word.lastIndexOf('/') + 1) || word : word;
  return withoutPath;
}

/**
 * Where the wrapped command starts, given the wrapper's own words.
 *
 * One helper instead of a stateful loop: `timeout 10 sudo ls` must skip *one* duration
 * word and then treat `sudo` as the command, while `xargs sudo rm` has no duration at all
 * and `xargs -n 1 sudo rm` has a flag whose value must not be mistaken for the command.
 */
function commandStart(binary: string, rest: readonly string[]): number {
  const values = WRAPPER_FLAGS_WITH_VALUE[binary] ?? [];
  let sawDuration = false;
  let index = 1;
  while (index < rest.length) {
    const word = rest[index] ?? '';
    if (word === '--') return index + 1;
    if (isFlag(word)) {
      index += values.includes(word) ? 2 : 1;
      continue;
    }
    if (isAssignment(word)) {
      index += 1;
      continue;
    }
    if (binary === 'timeout' && !sawDuration) {
      sawDuration = true;
      index += 1;
      continue;
    }
    return index;
  }
  return index;
}

/** Strip a wrapper's own words and return the command it runs. */
function unwrap(words: readonly string[], home: string | null): readonly string[] {
  let rest = [...words];
  for (;;) {
    const head = rest[0];
    if (head === undefined) return rest;
    const binary = basename(head);
    if (!WRAPPERS.has(binary)) {
      // `VAR=value cmd` is an environment prefix, not a command: `FOO=1 sudo ls` runs sudo.
      if (isAssignment(head)) {
        rest = rest.slice(1);
        continue;
      }
      return rest;
    }
    rest = rest.slice(commandStart(binary, rest));
  }
}

function classifySegment(
  rawWords: readonly string[],
  home: string | null,
  depth = 0,
): {
  segments: ClassifiedSegment[];
  privileged: boolean;
  ruleId: string | null;
  brokeredClass: BrokeredClass | null;
  ambiguous: boolean;
  detail: string;
} {
  const result = {
    segments: [] as ClassifiedSegment[],
    privileged: false,
    ruleId: null as string | null,
    brokeredClass: null as BrokeredClass | null,
    ambiguous: false,
    detail: '',
  };
  if (rawWords.length === 0) return result;

  const unwrapped = unwrap(rawWords, home);
  // The command word is normalised to its basename: `/usr/bin/sudo ls` and `sudo ls` are
  // one operation, and a decision granted for one must hold for the other.
  const words = [
    basename(unwrapped[0] ?? ''),
    ...unwrapped.slice(1).map((word) => normaliseWord(word, home)),
  ];
  const head = words[0] ?? '';
  const binary = head;

  // A shell's `-c` string (or `eval`) is a script: classify every segment inside it.
  if (
    depth < 4 &&
    (binary === 'eval' || (SHELLS.has(binary) && words.some((word) => word === '-c')))
  ) {
    const flagIndex = words.findIndex((word) => word === '-c');
    const script =
      binary === 'eval'
        ? words.slice(1).join(' ')
        : flagIndex >= 0
          ? (words[flagIndex + 1] ?? '')
          : '';
    result.segments.push({ words, dynamic: isDynamic(head) });
    // No separate "the whole script is an expansion" branch: a script that is a single
    // dynamic word (`sh -c "$SCRIPT"`) tokenises to one segment whose command position is
    // dynamic, which the per-segment check below already refuses. Two rules for one
    // condition would mean two messages for one fact.
    let privileged = false;
    let ruleId: string | null = null;
    let brokeredClass: BrokeredClass | null = null;
    let ambiguous = false;
    let detail = '';
    for (const inner of tokeniseShell(script)) {
      const classified = classifySegment(inner, home, depth + 1);
      result.segments.push(...classified.segments);
      if (classified.privileged) {
        privileged = true;
        ruleId ??= classified.ruleId;
        brokeredClass ??= classified.brokeredClass;
        detail ||= classified.detail;
      }
      if (classified.ambiguous) {
        ambiguous = true;
        ruleId ??= classified.ruleId;
        detail ||= classified.detail;
      }
    }
    return { ...result, privileged, ruleId, brokeredClass, ambiguous, detail };
  }

  if (isDynamic(head)) {
    return {
      ...result,
      ambiguous: true,
      ruleId: 'ambiguous.dynamic-word',
      detail: `the command position is an expansion (${head}); the broker cannot know which binary runs`,
    };
  }

  result.segments.push({
    words: words.map((word) => normaliseWord(word, home)),
    dynamic: false,
  });

  const rule = ruleFor(binary, words);
  if (rule !== null) {
    return {
      ...result,
      privileged: true,
      ruleId: rule.id,
      brokeredClass: rule.brokeredClass,
      detail: `${rule.describes} (rule ${rule.id})`,
    };
  }

  // A shell redirect writes a file regardless of which binary precedes it:
  // `echo x > /etc/hosts` is a write to `/etc`, and classifying it as `echo` would be the
  // exact blind spot the denylist has. Both the `> path` and `>path` spellings appear.
  const redirectTarget = redirectTargetOf(words, home);
  if (redirectTarget !== null && isPrivilegedPath(redirectTarget, home)) {
    return {
      ...result,
      privileged: true,
      ruleId: `path-write:redirect:${redirectTarget}`,
      brokeredClass: 'path-write',
      detail: `the operation redirects output into ${redirectTarget}, which is outside the worktree's authority`,
    };
  }

  const writesPrivilegedPath = words
    .slice(1)
    .some((word) => isPrivilegedPath(normaliseWord(word, home), home));
  if (!writesPrivilegedPath) {
    return { ...result, detail: `${binary} names no brokered operation and no privileged path` };
  }

  if (PATH_WRITER_BINARIES.includes(binary)) {
    const target = words
      .slice(1)
      .map((word) => normaliseWord(word, home))
      .find((word) => isPrivilegedPath(word, home));
    return {
      ...result,
      privileged: true,
      ruleId: `path-write:${String(target)}`,
      brokeredClass: 'path-write',
      detail: `${binary} writes ${String(target)}, which is outside the worktree's authority`,
    };
  }

  // An unknown binary naming a privileged path: nobody can say whether it writes, reads or
  // deletes — and unknown is not pass (L3). This is the fail-closed branch.
  return {
    ...result,
    ambiguous: true,
    ruleId: 'ambiguous.unknown-writer',
    detail: `${binary} is not a known writer but names a privileged path; the broker cannot prove what it does`,
  };
}

/**
 * Classify an argv. `home` is used only to normalise `~`/`$HOME`; `null` means the caller
 * has no home to resolve and the literal spellings are compared.
 */
export function classify(
  argv: readonly string[],
  options: { home: string | null },
): Classification {
  const segments: ClassifiedSegment[] = [];
  let privileged = false;
  let ambiguous = false;
  let ruleId: string | null = null;
  let brokeredClass: BrokeredClass | null = null;
  const details: string[] = [];

  // The caller's argv is *already* word-split: joining it and re-lexing would destroy the
  // script argument of `sh -c '<script>'` (its spaces and quotes would be re-split as if
  // they were the caller's, turning `sh -c 'sudo rm -rf /'` into `sh -c sudo rm -rf /`).
  // Shell *scripts* are tokenised inside `classifySegment`, where the string is known to
  // be a script.
  const classifiedSegments = [classifySegment([...argv], options.home)];
  for (const classified of classifiedSegments) {
    segments.push(...classified.segments);
    if (classified.privileged) {
      privileged = true;
      ruleId ??= classified.ruleId;
      brokeredClass ??= classified.brokeredClass;
      if (classified.detail !== '') details.push(classified.detail);
    }
    if (classified.ambiguous) {
      ambiguous = true;
      ruleId ??= classified.ruleId;
      if (classified.detail !== '') details.push(classified.detail);
    }
  }

  const operationClass: OperationClass =
    brokeredClass === null ? 'code-change' : CLASS_TO_OPERATION_CLASS[brokeredClass];
  return {
    operationClass,
    privileged,
    ambiguous,
    ruleId,
    brokeredClass,
    segments,
    detail:
      details.length > 0
        ? details.join('; ')
        : "no brokered operation: this argv stays inside the attempt's authority",
  };
}

/**
 * `sha256:` over the normalised segments — the operation a decision binds to.
 *
 * The hash covers the *classification's* segments rather than the caller's argv, so two
 * spellings of the same operation (`/usr/bin/sudo ls`, `sudo ls`, `env sudo ls`) share one
 * hash and cannot be used to dodge a decision that was granted for a different command.
 */
export function operationSha(classification: Classification): string {
  return contentHash({ segments: classification.segments.map((segment) => segment.words) });
}
