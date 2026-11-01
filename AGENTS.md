# AGENTS.md — working agreement

The conventions that were actually used to build this repository. They are not aspirations; every
one of them exists because ignoring it cost time. Read [`README.md`](README.md) for what the thing
is, [`docs/handover.md`](docs/handover.md) for where to start, and the audit
[`docs/planning/dark-factory-dsh/phase-13-audit.md`](docs/planning/dark-factory-dsh/phase-13-audit.md)
for what is real.

## Runtime: pin node in every shell

```bash
export PATH="$HOME/.nvm/versions/node/$(cat .nvmrc)/bin:$PATH"   # 26.12.1
```

Each `bash` invocation starts a fresh shell, so this line goes at the **top of every command**, not
once per session. Under an older node the preflight stage fails — that is fail-closed by design, and
"fixing" it by lowering the check is a regression. Node 26 strips types natively, so `node file.ts`
works; nothing here needs a runtime transpiler.

## TypeScript: explicit `.ts` extensions, and the strict flags are load-bearing

- **Every relative import carries its `.ts` extension** (`./context.ts`, not `./context`), because
  the tree is `module: nodenext` + `verbatimModuleSyntax` + `erasableSyntaxOnly`. This is not
  style: an extensionless import fails to resolve at runtime.
- `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`. `arr[0]` is `T | undefined`;
  annotate optional properties explicitly rather than relying on `?`. When a type error looks
  pedantic, fix the value or make the invariant a runtime check — do not reach for `as`.
- Imports of type-only symbols use `import type`. Namespace imports are fine; `export =` and
  `enum` are not (they need a transpiler).
- Workspace packages resolve **per app**, so in `e2e/` import by relative path
  (`../../packages/store/src/index.ts`), not by package name; `node_modules/@factory` does not
  necessarily link what you expect.

## Tests: never weaken one

- **Never weaken a test to make it pass.** Not by deleting an assertion, not by loosening a matcher,
  not with `.skip`, `.only`, `test.todo`, or a `try/catch` that swallows the failure. `pnpm run lint`
  fails on `.skip`/`.only` for exactly this reason (use `skipIf(condition, reason)` so the skip is a
  decision with a reason attached).
- When a test encodes the wrong behaviour, change the test **and write down why in the test**, with
  the reasoning in the diff. `b92f5cc` did this: a test asserted the two receipt hashes were
  _different_, and the test itself was the bug.
- A red test is information. If it is red before your change, say so and leave it alone — unless it
  is in your own scope.
- Add the failing case first when fixing a bug: the four never-regress controls are all "a spec that
  would have caught the bug".

## Ownership: report, do not patch someone else's package

- If a bug is in a package you do not own, **report it** — the file, the line, the failing command,
  the output — instead of editing that package. Silent cross-package edits are how two agents
  produce one inconsistent commit.
- When you must touch a shared seam, change the smallest surface and run the owning package's tests
  plus the e2e suite that exercises the seam.
- The Lead reviews the final diff and runs the gates. Do not declare a task done on a local red.

## Evidence over narration

- **A claim with no test is `UNPROVEN`, never `met`.** This is the audit's rule and it applies to
  your own work: "it should work", "I fixed that", "tests pass" without the command and its output
  are not results.
- **Run the command you quote.** If a doc or a message says `factory recover --observe`, run it
  first — that flag does not exist, and inventing it in a doc is worse than saying "not built".
  Where something promised is absent, write **not built** and link the audit.
- **Report the delta, not the story.** What changed (paths), what you ran and what it printed, and
  the deviations with reasons. Numbers that a reader can reproduce beat prose.
- **Never fabricate a green.** A skipped suite is `SKIPPED` with a reason — never a pass, never
  quietly dropped. `scripts/verify.sh` exists so that this is mechanical.

## Things you must not do

- Do not edit the ledger (SQLite store), reset `FACTORY_HOME`, or delete evidence to clear a state.
  Every state in this system is a fact someone needs to see; the runbooks say what to do instead.
- Do not add an `--force`/`-y`/`--assume-yes` escape hatch to a gate. Those flags are usage errors
  (exit `2`) — a gate that can be confirmed by muscle memory is not a gate.
- Do not put a model on a decision path (law L2), and do not let the agent's narrative into a hash,
  an identity, or a verdict (law L1).
- Do not add a `docs/planning/` task box or tick one. That plan set is a historical record; the
  audit's status table is where reality is recorded.

## The two commands to end every task with

```bash
pnpm run typecheck && pnpm run lint && pnpm run format:check
bash scripts/verify.sh
```

If they are red for a reason that is not yours, say which stage and who owns it, and say what you
ran. That is the whole agreement.
