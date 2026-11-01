/**
 * Which recorded command is the suite the receipt claims was green?
 *
 * Never by prompt substring. `commands[0]` is the worker launch, and **its prompt is an argv
 * element** — a `task.md` that mentions "suite" made a substring finder return the launch, and
 * the assertion then re-ran `dsh` for real: a paid model call made by a test, 17.8 s instead of
 * ~1 s. Selection is structural (`source: 'factory-verification'`), and when the receipt records
 * no suite command the answer is `null` so the caller can assert the absence instead of guessing.
 */
export interface RecordedCommand {
  readonly argv: readonly string[];
  readonly source?: string | undefined;
  readonly cwd?: string | undefined;
}

export function selectSuiteCommand(commands: readonly RecordedCommand[]): RecordedCommand | null {
  const verification = commands.filter(
    (command) => command.source === 'factory-verification' && command.argv[0] === 'node',
  );
  return (
    verification.find((command) => command.argv.slice(1).some((arg) => arg.includes('suite'))) ??
    verification[0] ??
    null
  );
}

/**
 * Why this command must not be executed by a test, or `null` when it is safe.
 *
 * Fails closed: an unknown first token is refused, so a future receipt shape cannot quietly turn
 * an assertion into a worker invocation.
 */
export function testRefusal(argv: readonly string[], dshBin: string): string | null {
  const [head] = argv;
  if (head === undefined || head === '') return 'refused: empty argv';
  if (head === dshBin || /(^|\/)dsh$/u.test(head)) {
    return 'refused: a test must never re-run the worker — the launch is a paid model call';
  }
  if (argv.join(' ').includes('--profile')) {
    return 'refused: a test must never re-run the worker (a --profile launch is the worker)';
  }
  if (!argv.join(' ').includes('suite')) return 'refused: not a suite command';
  return null;
}
