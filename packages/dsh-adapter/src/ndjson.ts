/**
 * Parsing `dsh --profile headless --json`.
 *
 * The stream is NDJSON, one projection event per line. The factory's outcome is
 * **never** the text the model wrote; it is the exit code plus the structured
 * `turn_end` reason. This module is the only thing that reads that stream, and
 * it is deliberately paranoid in three specific ways:
 *
 * 1. **`final` is not success.** DSH writes the terminal `final` event on the
 *    error path too (verified: a `MISSING_CREDENTIAL` run ends with
 *    `{"type":"final","text":""}` and exit 1). Treating "we saw a final" as
 *    "the turn finished" would report a failed attempt as a completed one.
 *    Success is exactly `turn_end.reason.kind === 'completed'`.
 * 2. **Truncation is a real, flagged state.** DSH bounds every string at 8 KiB
 *    and every line at 32 KiB, adding `truncated: true` to the event when it
 *    cuts (`packages/bundle/headless/src/json-stream.ts`, `MAX_STRING_BYTES`,
 *    `MAX_EVENT_BYTES`). A killed process can also leave a half-written final
 *    line. Both are surfaced, never silently dropped — a receipt that quietly
 *    loses events is worse than one that admits it.
 * 3. **Two event shapes.** The installed binary (0.2.1-rc.5) emits `turn_end` as
 *    its own `{"type":"turn_end"}`; the 0.2.1-alpha.4 checkout emits it as
 *    `{"type":"status","phase":"turn_end"}`. The adapter is version-pinned, but
 *    a parser that only understands one shape would silently see "no turn end"
 *    on the other and misclassify every run as ambiguous. Both are accepted.
 */

/** One `status` projection event, normalised. */
export interface StatusEntry {
  /** `turn_start` | `step_start` | `step_end` | `turn_end` | anything DSH adds later. */
  readonly phase: string;
  readonly turn: number | null;
  readonly step: number | null;
  readonly raw: Readonly<Record<string, unknown>>;
}

/** A structured DSH failure. `code` is DSH's own stable code, e.g. `MISSING_CREDENTIAL`. */
export interface DshError {
  readonly code: string;
  readonly message: string;
}

/** The terminal reason of the last turn, normalised. */
export interface TurnEnd {
  /**
   * `completed` | `error` | `aborted` | `blocked` | `max-tokens` | `interrupted`
   * | `forked` | any variant a plugin merges into DSH's `TurnEndReasonMap`.
   */
  readonly kind: string;
  readonly turn: number | null;
  /** Only set when `kind === 'error'`; the `LlmFailure` facts verbatim. */
  readonly error: DshError | null;
  readonly raw: Readonly<Record<string, unknown>>;
}

/** A line that could not be read, reported rather than swallowed. */
export interface MalformedLine {
  /** 1-based line number in the stream, so an operator can find it. */
  readonly line: number;
  readonly reason: string;
}

export interface HeadlessParse {
  readonly sessionId: string | null;
  readonly statuses: readonly StatusEntry[];
  readonly turnEnd: TurnEnd | null;
  readonly finalText: string | null;
  /** Set for a `turn_end` error reason *or* a driver-level `{"type":"error"}` event. */
  readonly error: DshError | null;
  /** True when a turn ended with `reason.kind === 'completed'`. Nothing else counts. */
  readonly ok: boolean;
  /** True when any event was flagged truncated, or the stream's tail was cut mid-line. */
  readonly truncated: boolean;
  /** Every unreadable line. Empty is the only acceptable value for a clean run. */
  readonly malformed: readonly MalformedLine[];
  /** Highest turn number observed, for `Ceilings.turnsUsed`. */
  readonly turnsUsed: number;
}

/**
 * Turn-end kinds that mean "the run did not succeed" but are not a `LlmFailure`.
 * They get a synthetic code so a caller can branch without string-matching prose.
 */
const NON_SUCCESS_CODES: Readonly<Record<string, string>> = {
  aborted: 'ABORTED',
  blocked: 'BLOCKED',
  'max-tokens': 'MAX_TOKENS',
  interrupted: 'INTERRUPTED',
  forked: 'FORKED',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) ? value : null;
}

/** `{ code, message }` out of whatever DSH put in `reason.error`. */
function readError(value: unknown): DshError | null {
  if (!isRecord(value)) return null;
  const code =
    typeof value['code'] === 'string' && value['code'] !== '' ? value['code'] : 'UNKNOWN';
  const message = typeof value['message'] === 'string' ? value['message'] : '';
  return { code, message };
}

/** Normalise a `turn/end` reason, whichever envelope carried it. */
function readTurnEnd(reason: unknown, turn: number | null, raw: Record<string, unknown>): TurnEnd {
  const kind = isRecord(reason) && typeof reason['kind'] === 'string' ? reason['kind'] : 'unknown';
  const error = kind === 'error' ? readError(isRecord(reason) ? reason['error'] : undefined) : null;
  return { kind, turn, error, raw };
}

/**
 * Parse one headless stream.
 *
 * Takes the already-split lines rather than a stream so the same function can
 * serve a live child (line-buffered by the caller) and a fixture. Empty and
 * whitespace-only lines are skipped; everything else must parse or be reported.
 */
export function parseHeadlessStream(lines: readonly string[]): HeadlessParse {
  let sessionId: string | null = null;
  const statuses: StatusEntry[] = [];
  let turnEnd: TurnEnd | null = null;
  let finalText: string | null = null;
  let error: DshError | null = null;
  const malformed: MalformedLine[] = [];
  let truncated = false;
  let turnsUsed = 0;
  let sawFinal = false;
  let lastContentLine = -1;

  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index] ?? '';
    const line = raw.trim();
    if (line === '') continue;
    lastContentLine = index;

    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch (cause) {
      // A cut tail is the expected cause (the process was killed mid-write);
      // anything else is corruption. Both are reported.
      malformed.push({
        line: index + 1,
        reason: cause instanceof Error ? cause.message : 'unparseable JSON',
      });
      continue;
    }
    if (!isRecord(event)) {
      malformed.push({ line: index + 1, reason: 'event is not a JSON object' });
      continue;
    }
    if (event['truncated'] === true) truncated = true;

    const type = typeof event['type'] === 'string' ? event['type'] : '';
    switch (type) {
      case 'session': {
        const id = event['sessionId'];
        if (typeof id === 'string' && id !== '') sessionId = id;
        else malformed.push({ line: index + 1, reason: 'session event without a sessionId' });
        break;
      }
      case 'status': {
        const phase = typeof event['phase'] === 'string' ? event['phase'] : 'unknown';
        const turn = asInt(event['turn']);
        const entry: StatusEntry = { phase, turn, step: asInt(event['step']), raw: event };
        statuses.push(entry);
        if (turn !== null && turn > turnsUsed) turnsUsed = turn;
        // alpha.4 shape: the turn end arrives as a status phase.
        if (phase === 'turn_end') turnEnd = readTurnEnd(event['reason'], turn, event);
        break;
      }
      case 'turn_end': {
        // rc.3 shape: its own event type.
        const turn = asInt(event['turn']);
        turnEnd = readTurnEnd(event['reason'], turn, event);
        if (turn !== null && turn > turnsUsed) turnsUsed = turn;
        break;
      }
      case 'final': {
        const text = event['text'];
        finalText = typeof text === 'string' ? text : '';
        sawFinal = true;
        break;
      }
      case 'error': {
        // Driver-level failure before a turn existed. DSH flattens unknown
        // errors to `code: 'UNKNOWN'`, so we do the same rather than invent one.
        const message = typeof event['message'] === 'string' ? event['message'] : '';
        error = {
          code:
            typeof event['code'] === 'string' && event['code'] !== '' ? event['code'] : 'UNKNOWN',
          message,
        };
        break;
      }
      default:
        // `thinking`, `text`, `tool_call`, `tool_result`, and anything a newer
        // DSH adds. Unknown types are not errors — a run must not be failed for
        // carrying an event this version does not model.
        break;
    }
  }

  // A `turn_end` error wins over a driver-level one: it is the more specific
  // account of the same failure. A non-success kind with no error object still
  // gets a machine-readable code so callers never parse prose.
  const effectiveError: DshError | null =
    turnEnd !== null && turnEnd.kind === 'error'
      ? (turnEnd.error ?? { code: 'UNKNOWN', message: '' })
      : turnEnd !== null && turnEnd.kind !== 'completed'
        ? {
            code: NON_SUCCESS_CODES[turnEnd.kind] ?? 'UNKNOWN',
            message: `turn ended: ${turnEnd.kind}`,
          }
        : error;

  // The stream ended mid-line: the last content line failed to parse and nothing
  // was written after it. That is a cut tail, not stray corruption.
  if (
    !sawFinal &&
    malformed.length > 0 &&
    malformed[malformed.length - 1]?.line === lastContentLine + 1
  ) {
    truncated = true;
  }

  return {
    sessionId,
    statuses,
    turnEnd,
    finalText,
    error: effectiveError,
    ok: turnEnd !== null && turnEnd.kind === 'completed',
    truncated,
    malformed,
    turnsUsed,
  };
}

/**
 * Split a byte stream into lines without losing a trailing partial line.
 *
 * Kept beside the parser because the two edge cases are one decision: a partial
 * line must reach the parser so it is *reported*, not dropped. Callers push
 * chunks and call {@link flush} at exit.
 */
export function createLineSplitter(): { push(chunk: string): string[]; flush(): string[] } {
  let buffer = '';
  return {
    push(chunk: string): string[] {
      buffer += chunk;
      const parts = buffer.split('\n');
      buffer = parts.pop() ?? '';
      return parts;
    },
    flush(): string[] {
      if (buffer === '') return [];
      const tail = buffer;
      buffer = '';
      return [tail];
    },
  };
}
