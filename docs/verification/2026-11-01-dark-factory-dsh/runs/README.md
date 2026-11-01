# Run archive

Each directory holds the two artefacts `scripts/verify.sh` writes on every run:

- `verify.log` — full, unstripped output of every stage with the command that produced it;
- `summary.json` — `schema: verify/1`: per-stage status/exit code/duration, environment facts
  (node, pnpm, git head, dsh presence, model-key presence), the `unknowns` list, and
  `ok`/`counts`.

| dir            | run                    | what it records                                                                                                                                        |
| -------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `as-found/`    | `2026-11-01T14-26-43Z` | the first run, taken while teammates were mid-edit: 2 pass / 4 fail, including 20 `typecheck` errors in untracked `apps/cli` verbs and 3 test failures |
| `no-api-keys/` | constraint 5a          | every stage with `BIFROST_API_KEY`/`DEEPSEEK_API_KEY`/`OPENAI_API_KEY`/`ANTHROPIC_API_KEY` unset: `test` PASS (934 passed, 4 skipped)                  |
| `no-dsh/`      | constraint 5b          | `env -i` PATH with no `dsh`, `FACTORY_DSH_BIN=/nonexistent/dsh`: `preflight` SKIPPED (exit 8), `test` PASS (925 passed, 13 skipped)                    |
| `final/`       | `2026-11-01T14-40-27Z` | the reported run: 4 pass / 1 skipped / 2 fail — only `lint` and `format:check` red                                                                     |

The copies here were made from the harness's own timestamped output directories, which are
ephemeral by design (each run makes a new one). `artifacts.log` / `artifacts.summary` inside a
copied `summary.json` still name the original `docs/verification/<timestamp>/…` path; the file
in this directory is the same bytes.
