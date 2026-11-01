# Evidence — live model through Bifrost (2026-11-01)

**Why this file exists:** every previous verification run carried the same `UNKNOWN` line — "DeepSeek via
Bifrost" was a _configuration_ claim, not a measured one. The operator created a program key for this
factory, so the claim could finally be tested. This file records the probe, the first real one-shot turn
through the installed DSH, and what the factory path still had to add.

The credential itself is **not** in this repository and must never be. It lives on `hermes-control` at
`/home/bo/.hermes/bifrost/program-secrets/software-factory-dsh/credential`, mode `0600`, 43 bytes, and is
read per command over SSH into an environment variable.

## 1. The gateway, measured

```
$ curl -o /dev/null -w '%{http_code}' -H "x-bf-vk: $K" https://hermes-control.tail4296e6.ts.net/openai/v1/models
200
$ curl -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $K" …/chat/completions
200
$ curl -o /dev/null -w '%{http_code}' -H "x-bf-vk: $K" …/chat/completions
200
```

Both header forms are accepted, which matters: DSH's `openai-completions` provider sends a Bearer token
from `apiKeyEnv`, so **no custom-header plumbing is required** — the factory can use the standard path
and still authenticate against a Bifrost program key.

```
$ curl -H "x-bf-vk: $K" …/openai/v1/models
{"object":"","data":[{"id":"ollama-cloud/deepseek-v4-pro:0813","object":"model","owned_by":"ollama",…}]}
```

The program is configured for model `auto`. What `auto` actually routes to is not the advertised id:

```
$ curl … -d '{"model":"auto","messages":[{"role":"user","content":"Reply with exactly: LIVE"}],"max_tokens":8}'
{"id":"chatcmpl-299","model":"deepseek-v4.1-flash:1017","choices":[{"message":{"content":"LIVE"}}],
 "usage":{"prompt_tokens":35,"completion_tokens":13,"total_tokens":48}, …}
```

So: `auto` → `deepseek-v4.1-flash:1017` at the gateway, with usage reported per call. Recorded here
because a routing name is not a model id, and a verdict that names the routing name would be less precise
than the gateway's own answer.

## 2. A real one-shot turn through the installed DSH

Binary `0.2.1-rc.3`, throwaway `DSH_HOME=/tmp/live-probe/home`, workspace `/tmp/live-probe/work`, and a
hand-written overlay (`api: openai-completions`, `baseURL` above, `apiKeyEnv: BIFROST_API_KEY`, `model:
'auto'`, sandbox `workspace-write`, approval `never`, the `factory-worker` preset, compaction off):

```
$ dsh --profile headless --patch overlay.yml --json "Reply with exactly the word LIVE…"
{"type":"session","sessionId":"session-c3aa3a76-…","cwd":"/private/tmp/live-probe/work"}
{"type":"status","phase":"turn_start","turn":1}
{"type":"status","phase":"step_start","turn":1,"step":1}
{"type":"text","text":"LIVE"}
{"type":"status","phase":"step_end","turn":1,"step":1,"usage":{"inputTokens":5676,"outputTokens":4,"totalTokens":5680}}
{"type":"status","phase":"turn_end","turn":1,"reason":{"kind":"completed"}}
{"type":"final","text":"LIVE"}
```

**This is the first measured proof of the model path**: a real turn, a real model, real usage, and the
`turn_end` reason the adapter's exit-code rule depends on (`exit 0` only on a completed `turn_end`).

## 3. The first paid factory run, and what it broke

The probe above used a hand-written overlay. The factory's own path was then run once, for real, with the
operator's key: unit `U-20be8c159df8`, attempt `A-e507950c0625`, model `auto`, **12,684 tokens across two
steps**, `turn_end.reason.kind = completed`, receipt written, wall measured.

Everything the wall measures about the _change_ was green — `acceptance:suite-green`, `suite`,
`holdout:01`, `delta`, `holdout:quality`, `test-surface`, `diff`, `tests-weakened`, `scope`,
`irreversible`, `class-certification` — and the verdict was still **`fail`**, on
`receipt_unfaithful` + `faithfulness_partial`, with the scope row reading
`replayed 7 of 8 recorded commands; 2 mismatched`.

That single run exposed three defects, none of which any offline spec had caught:

1. **The wall replayed the worker launch.** `receipt.commands[0]` is the `dsh` invocation itself:
   non-deterministic, side-effecting, and on a live run _billed_. The first fix made it honest but
   useless (`replayed 0 of 8` ⇒ `unknown` ⇒ by L3 no real worker could ever produce a promotable unit).
   The fix that stands: replay the verification reads **in recorded order from the receipt's base**, so
   the replay rebuilds the index (`git read-tree <base> && git add --all -- .`) instead of assuming it.
2. **Two of those reads are not replayable at all, and the wall said they were.** `git status
--porcelain` with untracked or ignored entries depends on files present in the _working directory_,
   which no commit records; the replay diverged on exactly those two rows (`--untracked-files=all`,
   `--ignored=matching`) while `--cached` diffs and `git ls-files --others --ignored` reproduced. The
   honest classification is unreplayable-with-reason, giving a measured **5 of 8**.
3. **The scope row reported `2 mismatched` while carrying `outcome: pass`.** A row that counts a
   divergence cannot be green; the overall verdict was right only because `receipt_unfaithful` happened
   to accompany it — a coupling the verdict text should not depend on.

The pattern is the one this repository keeps re-learning: **the mechanism was correct and its inputs were
not.** Offline fixtures had the receipt shape the wall wanted; the real receipt had the shape the
factory actually produces, and the difference only appears when a real worker runs.

## 4. The first verified unit (2026-11-01, second paid run)

After the three defects above were fixed, one more real run — unit `U-4a340469fe0d`, attempt
`A-66c646aa681e` — produced the first **genuine pass** in this repository's history, read from the
attempt's own store:

```
outcome: pass   reasons: []   delta: {baseRate 0, candidateRate 1, threshold 0.2, checked true}
faithfulness:scope   replayed 5 of 8 recorded commands; 0 mismatched
faithfulness:06/07   pass  — not replayed, with reasons (git status: untracked / ignored entries)
faithfulness:01      pass  — not replayed (worker-launch)
faithfulness:02-05,08 pass — exit code and output hash reproduced
acceptance:suite-green, suite, holdout:01, holdout:quality (1 of 1 distinguishing) — all pass
receipt exitCode 0 · 8 commands, provenance as designed
CLI: exit 0 · state verified · wallVersion wall/0.1.0+local · fakeWall false
usage: step 1 101 in / 95 out / 8,132 total (7,936 cached); step 2 223 / 92 / 8,379 (8,064 cached)
```

That is the whole claim of the project, measured once: a dark agent produced a change, the wall
rejected neither it nor its evidence, the holdout discriminated the change from the base, and the
verdict carried no reason at all.

The spec that ran it was still red — **on its own guard**, which looked for `receipt.json` in the
attempt directory. The real executor never writes that file: the receipt is a row in
`state/factory.db`, and the attempt directory holds `launch.json`, `attempt.patch`, `command-
provenance.json`, `stdout.log` and the session tree. A test asserting an artifact only the fake executor
ever produced is the same defect the audit keeps finding, one level up: the guard was describing a
system that does not exist.

## 5. What this probe does **not** prove

- **Not the factory's path.** This overlay was hand-written. The factory builds its own
  (`packages/dsh-adapter/src/overlay.ts`), and until the integration below lands, the fact that DSH can
  talk to Bifrost says nothing about whether the factory configures it correctly.
- **Not the wall.** No receipt was produced, so nothing re-executed anything; a live turn is not a
  verdict.
- **Not the credential boundary.** The probe passed `BIFROST_API_KEY` in the dsh process's environment.
  The factory's launch record _refuses_ credential-shaped names by category, which is correct in a world
  with a credential proxy — and that proxy is **not built** (ADR-006). v1 therefore needs an explicit,
  recorded opt-in for live runs; the shape and the evidence for it follow below once integrated.
- **Not a pass-rate claim.** Two calls, both trivial. Nothing here says anything about how often a real
  task succeeds — and per A14, no such claim is certified by this project anyway.
