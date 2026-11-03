/**
 * The reason code was changed **additively**, and this file is the proof that the old evidence still
 * reads.
 *
 * `privileged_unbrokered` reads as "the operation was never approved", while what the wall actually
 * observed is "I refused to replay it". The honest fix would be a rename — and a rename is not
 * available: `WALL_REASON_CODES` is a closed zod enum in `@factory/contracts`, so renaming or
 * dropping a member makes every stored verdict carrying that string fail to parse. The evidence
 * outlives the wording.
 *
 * So the contract gained `privileged_replay_refused` (new verdicts emit it) and kept
 * `privileged_unbrokered` (old verdicts). This file pins the half a rename would have broken.
 *
 * The stored verdict below is a **literal JSON string**, not an object built from the current types.
 * A fixture constructed from `Verdict`/`WALL_REASON_CODES` would move with the code it is supposed
 * to be holding still, and the spec would prove nothing; this one is bytes a pre-change wall wrote
 * to `$FACTORY_HOME/verdicts/<id>.json`, and it has to parse for as long as that file is kept.
 */
import { describe, expect, it } from 'vitest';

import { assertVerdictIsEarned, Verdict } from '@factory/contracts';

/**
 * A refused privileged replay as it existed on disk before the additive code. Copied verbatim, not
 * derived: **do not "fix" the `privileged_unbrokered` string below to the new code.** If that string
 * ever needs to change, the migration has to change the stored rows first, not this expectation.
 */
const STORED_VERDICT_JSON = `{
  "unitId": "unit-1",
  "attemptId": "attempt-1",
  "receiptSha": "sha256:5c2b8a8a4b4f3dc1d6f0e1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6",
  "holdoutRevision": "absent",
  "policyVersion": "wall-policy/3f9a1c",
  "wallVersion": "wall/0.1.0+local",
  "outcome": "unknown",
  "scenarios": [
    {
      "id": "faithfulness:01",
      "source": "faithfulness",
      "outcome": "unknown",
      "observed": "GATE_REQUIRED: cp writes /etc/hosts, which is outside the worktree's authority. A privileged operation needs a recorded human decision (GateDecision) for exactly this command; none was presented. Operation hash: sha256:c68f6756. [broker.no-decision]"
    },
    {
      "id": "suite",
      "source": "suite",
      "outcome": "unknown",
      "observed": null
    },
    {
      "id": "holdout",
      "source": "holdout",
      "outcome": "unknown",
      "observed": null
    },
    {
      "id": "delta",
      "source": "delta",
      "outcome": "unknown",
      "observed": null
    }
  ],
  "delta": {
    "checked": false,
    "baseRate": null,
    "candidateRate": null,
    "threshold": 0,
    "observed": null,
    "holdoutRevision": "absent"
  },
  "reasons": ["privileged_unbrokered", "suite_unknown", "holdout_unavailable", "delta_unmeasured"],
  "evaluatedAt": "2026-11-02T23:19:42.126Z"
}`;

describe('a stored verdict that names the old reason code', () => {
  it('[a verdict written before the additive code still parses, with its reason unchanged]', () => {
    // Parsed as `unknown` first: the point is that the contract accepts the bytes, not that a
    // hand-written object happens to look like them.
    const raw: unknown = JSON.parse(STORED_VERDICT_JSON);
    const verdict = Verdict.parse(raw);

    expect(verdict.outcome).toBe('unknown');
    // The literal strings, not enum members: if `privileged_unbrokered` is ever renamed or dropped,
    // this parse throws and the spec goes red — instead of the old evidence becoming unreadable in
    // the field, where nobody would see it until they needed it.
    expect(verdict.reasons).toEqual([
      'privileged_unbrokered',
      'suite_unknown',
      'holdout_unavailable',
      'delta_unmeasured',
    ]);
    // The whole barrier, not just the schema: an `unknown` verdict with reasons must stay storable,
    // which is what `assertVerdictIsEarned` is asked on the way out.
    expect(() => assertVerdictIsEarned(verdict)).not.toThrow();
  });
});
