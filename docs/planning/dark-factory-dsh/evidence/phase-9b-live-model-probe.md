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

## 3. What this probe does **not** prove

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
