/**
 * The parser decides what a run *was*. Every branch here is a way a run can be
 * misreported, so the tests are mostly about the wrong answers being unavailable.
 */

import { describe, expect, it } from 'vitest';

import { createLineSplitter, parseHeadlessStream } from '../src/ndjson.ts';

const session = '{"type":"session","sessionId":"s1"}';

describe('parseHeadlessStream', () => {
  it('reads a completed turn as success, keeping the final text', () => {
    const parsed = parseHeadlessStream([
      session,
      '{"type":"status","phase":"turn_start","turn":1}',
      '{"type":"text","text":"working"}',
      '{"type":"turn_end","turn":1,"reason":{"kind":"completed"}}',
      '{"type":"final","text":"all done"}',
    ]);
    expect(parsed.sessionId).toBe('s1');
    expect(parsed.ok).toBe(true);
    expect(parsed.turnEnd?.kind).toBe('completed');
    expect(parsed.finalText).toBe('all done');
    expect(parsed.error).toBeNull();
    expect(parsed.turnsUsed).toBe(1);
    expect(parsed.malformed).toStrictEqual([]);
    expect(parsed.truncated).toBe(false);
  });

  it('treats a terminal final without a turn end as no verdict', () => {
    // DSH writes `final` on the error path too. "We saw a final" is not success.
    const parsed = parseHeadlessStream([session, '{"type":"final","text":"I think I did it"}']);
    expect(parsed.ok).toBe(false);
    expect(parsed.turnEnd).toBeNull();
    expect(parsed.finalText).toBe('I think I did it');
  });

  it('surfaces an error reason with its DSH code', () => {
    const parsed = parseHeadlessStream([
      session,
      '{"type":"turn_end","turn":1,"reason":{"kind":"error","error":{"message":"bad key","code":"MISSING_CREDENTIAL"}}}',
      '{"type":"final","text":""}',
    ]);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toStrictEqual({ code: 'MISSING_CREDENTIAL', message: 'bad key' });
  });

  it('accepts the turn end delivered as a status phase', () => {
    // The 0.2.1-alpha.4 checkout emits `{"type":"status","phase":"turn_end"}`;
    // the installed rc.3 emits `{"type":"turn_end"}`. A parser that knows one
    // shape sees no turn end on the other and calls every run ambiguous.
    const parsed = parseHeadlessStream([
      session,
      '{"type":"status","phase":"turn_end","turn":3,"reason":{"kind":"completed"}}',
    ]);
    expect(parsed.ok).toBe(true);
    expect(parsed.turnEnd?.turn).toBe(3);
    // The turn end still counts as a status, so turn accounting stays complete.
    expect(parsed.statuses.map((s) => s.phase)).toStrictEqual(['turn_end']);
  });

  it('gives a non-error non-success reason a machine-readable code', () => {
    const parsed = parseHeadlessStream([
      session,
      '{"type":"turn_end","turn":2,"reason":{"kind":"max-tokens"}}',
    ]);
    expect(parsed.ok).toBe(false);
    expect(parsed.turnEnd?.kind).toBe('max-tokens');
    expect(parsed.error?.code).toBe('MAX_TOKENS');
    expect(parsed.turnsUsed).toBe(2);
  });

  it.each(['aborted', 'blocked', 'interrupted', 'forked'])(
    'refuses to call %s a completed run',
    (kind) => {
      const parsed = parseHeadlessStream([
        session,
        `{"type":"turn_end","turn":1,"reason":{"kind":"${kind}"}}`,
      ]);
      expect(parsed.ok).toBe(false);
      expect(parsed.error?.code).toBe(kind.toUpperCase());
    },
  );

  it('reads a driver-level error event, which arrives before any turn', () => {
    const parsed = parseHeadlessStream(['{"type":"error","message":"cannot start"}']);
    expect(parsed.ok).toBe(false);
    expect(parsed.sessionId).toBeNull();
    expect(parsed.error).toStrictEqual({ code: 'UNKNOWN', message: 'cannot start' });
  });

  it('prefers the turn end error over a driver-level one', () => {
    const parsed = parseHeadlessStream([
      '{"type":"error","message":"generic"}',
      '{"type":"turn_end","turn":1,"reason":{"kind":"error","error":{"message":"specific","code":"PROVIDER_ERROR"}}}',
    ]);
    expect(parsed.error).toStrictEqual({ code: 'PROVIDER_ERROR', message: 'specific' });
  });

  it('flags an event DSH truncated', () => {
    const parsed = parseHeadlessStream([
      session,
      '{"type":"tool_call","tool":"bash","input":{"command":"x"},"truncated":true}',
      '{"type":"turn_end","turn":1,"reason":{"kind":"completed"}}',
    ]);
    expect(parsed.truncated).toBe(true);
    expect(parsed.ok).toBe(true);
  });

  it('flags a stream cut mid-line as truncated, not as clean', () => {
    const parsed = parseHeadlessStream([
      session,
      '{"type":"turn_end","turn":1,"reason":{"kind":"completed"}}',
      '{"type":"final","text":"the answer was al',
    ]);
    expect(parsed.truncated).toBe(true);
    expect(parsed.malformed).toHaveLength(1);
    expect(parsed.malformed[0]?.line).toBe(3);
  });

  it('reports a corrupt line without pretending the stream was cut', () => {
    const parsed = parseHeadlessStream([
      session,
      'not json at all',
      '{"type":"turn_end","turn":1,"reason":{"kind":"completed"}}',
    ]);
    expect(parsed.malformed).toHaveLength(1);
    expect(parsed.truncated).toBe(false);
    expect(parsed.ok).toBe(true);
  });

  it('reports a non-object line', () => {
    const parsed = parseHeadlessStream(['42', '[1,2]']);
    expect(parsed.malformed.map((m) => m.reason)).toStrictEqual([
      'event is not a JSON object',
      'event is not a JSON object',
    ]);
  });

  it('reports a session event that lost its id', () => {
    const parsed = parseHeadlessStream(['{"type":"session"}']);
    expect(parsed.sessionId).toBeNull();
    expect(parsed.malformed[0]?.reason).toMatch(/without a sessionId/);
  });

  it('ignores event types this version does not model', () => {
    // A newer DSH adding an event type must not fail a run.
    const parsed = parseHeadlessStream([
      session,
      '{"type":"something_new","value":1}',
      '{"type":"turn_end","turn":1,"reason":{"kind":"completed"}}',
    ]);
    expect(parsed.malformed).toStrictEqual([]);
    expect(parsed.ok).toBe(true);
  });

  it('skips blank lines without reporting them', () => {
    const parsed = parseHeadlessStream(['', '   ', session, '']);
    expect(parsed.malformed).toStrictEqual([]);
    expect(parsed.sessionId).toBe('s1');
  });

  it('handles an empty stream', () => {
    const parsed = parseHeadlessStream([]);
    expect(parsed.ok).toBe(false);
    expect(parsed.sessionId).toBeNull();
    expect(parsed.finalText).toBeNull();
    expect(parsed.turnEnd).toBeNull();
    expect(parsed.turnsUsed).toBe(0);
  });
});

describe('createLineSplitter', () => {
  it('holds a partial line until its newline arrives', () => {
    const splitter = createLineSplitter();
    expect(splitter.push('{"a":1}\n{"b":')).toStrictEqual(['{"a":1}']);
    expect(splitter.push('2}\n')).toStrictEqual(['{"b":2}']);
    expect(splitter.flush()).toStrictEqual([]);
  });

  it('returns a trailing partial line on flush so it is reported, not lost', () => {
    const splitter = createLineSplitter();
    splitter.push('{"cut":');
    expect(splitter.flush()).toStrictEqual(['{"cut":']);
    expect(splitter.flush()).toStrictEqual([]);
  });

  it('reassembles one line delivered in many chunks', () => {
    // stdout arrives in whatever slices the kernel produced, so a long line can
    // be split anywhere. The splitter must rejoin it exactly, multi-byte
    // characters included.
    const splitter = createLineSplitter();
    const line = '{"type":"text","text":"héllo wörld"}';
    const chunks = [line.slice(0, 3), line.slice(3, 20), line.slice(20), '\n'];
    const collected: string[] = [];
    for (const chunk of chunks) collected.push(...splitter.push(chunk));
    expect(collected).toStrictEqual([line]);
    expect(JSON.parse(collected[0] ?? '{}')).toStrictEqual({ type: 'text', text: 'héllo wörld' });
  });
});
