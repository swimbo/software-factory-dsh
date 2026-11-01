# Evidence — DSH integration probe (2026-11-01)

**Purpose:** de-risk Phase 9b before planning is approved. All commands were run against the **installed** DSH binary, not the checkout.

**Binary:** `/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh` → `0.2.1-rc.3`
**Isolation of the probe:** `DSH_HOME=/tmp/factory-probe/home` (throwaway), `cwd=/tmp/factory-probe/work`, `DSH_TELEMETRY_DISABLED=1`. Nothing in the operator's real `~/.dsh` was touched.

---

## Probe 1 — can a `--patch` overlay decouple approval policy from sandbox mode?

**Why it matters:** the shipped base patch (`packages/bundle/base/cordis.patch.yml:239-264`) sets `approval.policy: never` **only** when `DSH_PERMISSION_MODE === 'danger-full-access'`; in `workspace-write` it is `ask`, and a headless run cannot answer an ask (fails closed). If we cannot decouple them, every unattended worker either stalls or runs at `danger-full-access`.

First overlay attempt (sandbox + approval only):

```yaml
- id: sandbox-policy
  name: '@deepseek-ai/dsh-sandbox-policy'
  config: { mode: workspace-write, workspaceRoot: /tmp/factory-probe/work }
- id: approval
  name: '@deepseek-ai/dsh-user-approval'
  config: { policy: never }
```

Result: the task ran, but **one plugin failed to activate**:

```
dsh: warning: 1 entry did not activate
permission (@deepseek-ai/dsh-permission-presets): Error: permission: composed sandbox
and approval defaults match no preset; configure defaultPreset explicitly
```

**Diagnosis:** the permission-presets service validates that the composed sandbox+approval pair matches a _named_ preset. Decoupling is possible, but the overlay must declare the pair as a preset and name it as the default.

Second overlay attempt (adds an explicit preset):

```yaml
- id: permission
  name: '@deepseek-ai/dsh-permission-presets'
  config:
    defaultPreset: factory-worker
    presets:
      factory-worker: { sandbox: workspace-write, approval: never }
```

Result: **no warning**, the entry activates, and the run proceeds to the model call:

```
{"type":"session","sessionId":"session-0f77a93f-…","cwd":"/private/tmp/factory-probe/work"}
{"type":"status","phase":"turn_start","turn":1}
{"type":"status","phase":"step_start","turn":1,"step":1}
{"type":"status","phase":"step_end","turn":1,"step":1}
{"type":"turn_end","reason":{"kind":"error","error":{"code":"MISSING_CREDENTIAL"}}}
EXIT=1
```

**Conclusion:** the correct factory overlay is **three entries**: `sandbox-policy` (mode + workspaceRoot), `approval` (policy `never`), and `permission-presets` (named `factory-worker` preset + `defaultPreset`). Phase 9b's `profile.ts` must emit all three; emitting only the first two produces a silently degraded permission service — exactly the kind of thing that must not be discovered during a dark run.

---

## Probe 2 — does the overlay actually route the model to the Bifrost proxy?

Overlay additionally overrides the provider and the default model:

```yaml
- id: llm-pi-ai
  name: '@deepseek-ai/dsh-llm-pi-ai'
  config:
    providers:
      bifrost:
        displayName: Bifrost (factory proxy)
        apiKeyEnv: BIFROST_API_KEY
        api: anthropic-messages
        baseURL: http://127.0.0.1:8788/anthropic
        models: [{ id: factory-worker-tier, name: Factory worker tier }]
- id: agent-default-model
  name: '@deepseek-ai/dsh-agent-default-model'
  config: { provider: bifrost, model: factory-worker-tier }
```

Result:

```
llm-pi-ai: no credential for provider route "bifrost"; its profile resolves
BIFROST_API_KEY, which is not set — store BIFROST_API_KEY through the credentials
service … EXIT=1
```

**Conclusion:** the worker's model route is fully controllable per attempt from the overlay — provider id, wire protocol (`anthropic-messages`), base URL (the factory proxy), and model id (`factory-worker-tier`). The credential is referenced **by env-var name only**, so the worker never needs the secret value; the proxy can hold the real key. Constraint C1 (DeepSeek via Bifrost) is implemented at the overlay layer, not by editing DSH.

---

## Probe 3 — `$DSH_HOME` isolation

Both runs used a throwaway `DSH_HOME`. The failure messages show no home-layer MCP servers or third-party plugins were loaded (contrast: the Phase-5 research observed the operator's gmail/calendar MCP servers when an unisolated headless run used the real home). **Conclusion:** one `DSH_HOME` per trust domain is both necessary and sufficient to keep the operator's home layer out of factory runs.

## Probe 4 — exit-code contract, re-confirmed

- Successful NDJSON sequence ends with `{"type":"final","text":…}` and exit **0** only when a `turn/end` completes.
- An error inside a turn yields `turn_end.reason.kind = "error"` **and exit 1** with `dsh: <CODE>: <message>` on stderr — the adapter can therefore classify failure from exit code + machine-readable reason, never from prose.

---

## What this changes in the plan

| Item                         | Change                                                                                                                                  |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `phase-9b` overlay generator | must emit **three** permission entries (sandbox-policy, approval, permission-presets with a named preset) — not two                     |
| `architecture.md §2.2`       | overlay description now names the named-preset requirement                                                                              |
| `tech-guide.md §6`           | adds the verified Bifrost provider config shape (proxy baseURL + `apiKeyEnv` reference + per-role model id)                             |
| Risk register                | "silently degraded permission service" added as a 9b failure mode with a test (assert the plugin activates; fail on `did not activate`) |

---

## Reproduce

```sh
mkdir -p /tmp/factory-probe/{home,work}
# write overlay2.yml as shown above
cd /tmp/factory-probe/work
DSH_HOME=/tmp/factory-probe/home DSH_TELEMETRY_DISABLED=1 \
  "$DSH_BIN" --profile headless --patch /tmp/factory-probe/overlay2.yml --json "say hi"
# expect: turn_end kind=error code=MISSING_CREDENTIAL for route "bifrost", EXIT=1, no activation warning
```
