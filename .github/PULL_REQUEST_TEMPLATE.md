## Outcome

What behaviour changes, and what does it replace? Say which claim in `README.md` this moves.

## Verification

- [ ] `pnpm run typecheck && pnpm run lint && pnpm run format:check` clean.
- [ ] `bash scripts/verify.sh` green, and the log path is quoted in this description.
- [ ] Any gate weakened, spec renamed, or `UNKNOWN`/`SKIPPED` added is called out explicitly.
- [ ] No `docs/planning/` task box was ticked (that set is a historical record).
- [ ] Nothing claims a measurement the run did not produce.

## Scope

- [ ] The change is inside the packages/apps I own, or the owner was told before the edit.
- [ ] A failure I did not cause is named with its stage and owner, not silently absorbed.
