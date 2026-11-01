/**
 * Reading usage off the wire — the only place a spend number may come from.
 *
 * ND3 (ratified): the gateway is the source of truth for spend. So this module does not
 * estimate from the prompt, does not count characters, and does not fall back to the
 * reservation: it reads the `usage` the gateway itself reported. Two shapes reach us:
 *
 * - **JSON** (a non-streaming completion): `{"usage":{"prompt_tokens":…,"completion_tokens":…}}`
 *   (OpenAI) or `{"usage":{"input_tokens":…,"output_tokens":…}}` (Anthropic). Some
 *   OpenAI-compatible gateways also send `total_tokens`; it is used only as a cross-check.
 * - **SSE** (a streaming completion): a sequence of `data: {...}` lines. The usage block is in
 *   the *final* chunk — for OpenAI it arrives once the stream is closing, and for Anthropic it
 *   is split across `message_start` (`input_tokens`, in `message.usage`) and
 *   `message_delta` (`output_tokens`). Both are handled by folding every chunk's usage into
 *   one total, because "which chunk carried it" is a property of the vendor, not of spend.
 *
 * The distinction that matters for honesty: **no usage block is `unknown`, never zero.** A
 * gateway that answers 200 with no numbers has told us nothing, and a zero would make the
 * budget look healthier the less the gateway cooperates.
 */
import type { IncomingHttpHeaders } from 'node:http';

/** What one upstream call reported. Every field is nullable because a gateway may omit any. */
export interface UsageObservation {
  readonly tokensIn: number | null;
  readonly tokensOut: number | null;
  /** Cost in USD when the response priced itself. `null` means "the gateway did not say". */
  readonly costUsd: number | null;
  /** `x-request-id` header, else the body's `id`; the join key against a gateway export. */
  readonly gatewayRequestId: string | null;
  /** Whether the numbers came from the gateway, from the operator's price table, or nowhere. */
  readonly costSource: 'gateway' | 'estimated' | 'unknown';
  /** Bytes of the response that were parsed, so a truncated/oversized body is visible. */
  readonly parsedBytes: number;
  readonly truncated: boolean;
}

/** The shape accumulated for one attempt token. */
export interface UsageTotals {
  readonly tokensIn: number;
  readonly tokensOut: number;
  /** Sum of priced calls only. `null` when *no* call was priced: never a measured zero. */
  readonly costUsd: number | null;
  readonly requests: number;
  /** Calls whose tokens were reported but whose price was not. Reported, never hidden. */
  readonly unpricedRequests: number;
  readonly gatewayRequestIds: readonly string[];
  readonly ceilingCrossed: boolean;
}

export interface PriceTable {
  readonly inPerTokenUsd: number;
  readonly outPerTokenUsd: number;
}

const MAX_PARSE_BYTES = 1024 * 1024;

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

/** The usage block of a JSON object, in either vendor's spelling. */
export interface ParsedUsage {
  readonly tokensIn: number | null;
  readonly tokensOut: number | null;
  readonly costUsd: number | null;
  readonly id: string | null;
}

/**
 * Read a usage block from an already-parsed JSON value.
 *
 * `usage` may sit at the top level (OpenAI) or inside `message` (Anthropic's
 * `message_start` event). Costs, when present, are vendor extensions: `usage.cost`,
 * `usage.total_cost`, or a top-level `cost`.
 */
export function usageOf(value: unknown): ParsedUsage | null {
  if (value === null || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const message =
    record['message'] !== null && typeof record['message'] === 'object'
      ? (record['message'] as Record<string, unknown>)
      : null;
  const usage =
    record['usage'] !== null && typeof record['usage'] === 'object'
      ? (record['usage'] as Record<string, unknown>)
      : message !== null && message['usage'] !== null && typeof message['usage'] === 'object'
        ? (message['usage'] as Record<string, unknown>)
        : null;
  if (usage === null) return null;
  const tokensIn = numberOrNull(usage['prompt_tokens'] ?? usage['input_tokens']);
  const tokensOut = numberOrNull(usage['completion_tokens'] ?? usage['output_tokens']);
  const costUsd = numberOrNull(usage['cost'] ?? usage['total_cost'] ?? record['cost']);
  const id = typeof record['id'] === 'string' ? record['id'] : null;
  if (tokensIn === null && tokensOut === null && costUsd === null) return null;
  return { tokensIn, tokensOut, costUsd, id };
}

/** Whether a response is an event stream rather than one JSON document. */
export function isEventStream(headers: IncomingHttpHeaders): boolean {
  const type = headers['content-type'];
  return typeof type === 'string' && type.toLowerCase().includes('text/event-stream');
}

/**
 * Read usage out of an SSE body: fold every `data:` chunk, keep the last non-empty value.
 *
 * Chunks are folded rather than "take the final one" because an Anthropic stream splits the
 * two numbers across two events, and a rule of "the last usage block wins" would then report
 * output tokens and zero input. Folding also survives gateways that send usage only when the
 * stream is interrupted, which is exactly the case where the spend still happened.
 */
export function parseSseUsage(body: string): ParsedUsage | null {
  let tokensIn: number | null = null;
  let tokensOut: number | null = null;
  let costUsd: number | null = null;
  let id: string | null = null;
  let saw = false;
  for (const line of body.split(/\r?\n/u)) {
    if (!line.startsWith('data:')) continue;
    const payload = line.slice('data:'.length).trim();
    if (payload === '' || payload === '[DONE]') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      // A partial line at the tail of a truncated stream is not usage; skipping it and leaving
      // the counts as they were is the difference between "unknown" and "made up".
      continue;
    }
    const usage = usageOf(parsed);
    if (usage === null) continue;
    saw = true;
    if (usage.tokensIn !== null) tokensIn = Math.max(tokensIn ?? 0, usage.tokensIn);
    if (usage.tokensOut !== null) tokensOut = (tokensOut ?? 0) + usage.tokensOut;
    if (usage.costUsd !== null) costUsd = (costUsd ?? 0) + usage.costUsd;
    if (usage.id !== null) id = usage.id;
  }
  if (!saw) return null;
  return { tokensIn, tokensOut, costUsd, id };
}

/**
 * Turn a response body into one observation.
 *
 * Never throws: a body that cannot be parsed is `unknown`, not a failed request. The model
 * call may well have succeeded — the accounting must not turn that into an error the worker
 * sees, because the worker did nothing wrong.
 */
export function observeUsage(input: {
  readonly body: string;
  readonly headers: IncomingHttpHeaders;
  readonly requestIdHeader?: string | null;
  readonly priceTable?: PriceTable | undefined;
  readonly truncated?: boolean;
}): UsageObservation {
  const parsedBytes = Buffer.byteLength(input.body, 'utf8');
  const truncated = input.truncated === true;
  let parsed: ParsedUsage | null = null;
  if (!truncated) {
    parsed = isEventStream(input.headers)
      ? parseSseUsage(input.body)
      : usageOf(safeParse(input.body));
  }
  const headerId = input.requestIdHeader ?? null;
  const gatewayRequestId = headerId !== null && headerId !== '' ? headerId : (parsed?.id ?? null);

  let costUsd = parsed?.costUsd ?? null;
  let costSource: UsageObservation['costSource'] = costUsd === null ? 'unknown' : 'gateway';
  if (costUsd === null && input.priceTable !== undefined) {
    const tokensIn = parsed?.tokensIn ?? null;
    const tokensOut = parsed?.tokensOut ?? null;
    if (tokensIn !== null || tokensOut !== null) {
      costUsd =
        (tokensIn ?? 0) * input.priceTable.inPerTokenUsd +
        (tokensOut ?? 0) * input.priceTable.outPerTokenUsd;
      costSource = 'estimated';
    }
  }
  return {
    tokensIn: parsed?.tokensIn ?? null,
    tokensOut: parsed?.tokensOut ?? null,
    costUsd,
    gatewayRequestId,
    costSource,
    parsedBytes,
    truncated,
  };
}

function safeParse(body: string): unknown {
  const trimmed = body.trim();
  if (trimmed === '') return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

/** Fold one observation into the running totals for an attempt. */
export function foldUsage(
  previous: UsageTotals | undefined,
  observation: UsageObservation,
): UsageTotals {
  const before = previous ?? {
    tokensIn: 0,
    tokensOut: 0,
    costUsd: null,
    requests: 0,
    unpricedRequests: 0,
    gatewayRequestIds: [],
    ceilingCrossed: false,
  };
  const priced = observation.costUsd !== null;
  return {
    tokensIn: before.tokensIn + (observation.tokensIn ?? 0),
    tokensOut: before.tokensOut + (observation.tokensOut ?? 0),
    // `null` stays `null` until the first priced call: an unpriced attempt is unknown, and
    // adding zero to it would turn "we do not know" into "$0.00 reported".
    costUsd: priced ? (before.costUsd ?? 0) + (observation.costUsd ?? 0) : before.costUsd,
    requests: before.requests + 1,
    unpricedRequests: before.unpricedRequests + (priced ? 0 : 1),
    gatewayRequestIds:
      observation.gatewayRequestId === null
        ? before.gatewayRequestIds
        : [...before.gatewayRequestIds, observation.gatewayRequestId],
    ceilingCrossed: before.ceilingCrossed,
  };
}

export { MAX_PARSE_BYTES };
