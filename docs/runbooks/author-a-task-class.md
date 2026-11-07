# Authoring a task class

A task class is a corpus of rules plus a declaration of what the worker can see. This runbook is the path
from "I want a class that catches X" to "the class is authored, and here is the evidence it catches X". It
does not certify anything: certification is a separate, spending decision
([`certify-class.md`](certify-class.md)).

Two commands, and the point of each:

| command                | writes                                               | spends  |
| ---------------------- | ---------------------------------------------------- | ------- |
| `factory class new`    | a revision that **fails every rule by construction** | nothing |
| `factory class doctor` | nothing — it runs the class and reports              | nothing |

The doctor never repairs a corpus. Its findings are sentences that say what to change; changing them is your
decision, in a diff, with a reason.

## 1. Scaffold

```
$ factory class new --class whitespace-hygiene --root /tmp/class-demo \
    --rule no-trailing-whitespace --rule no-tabs-in-src \
    --visible "node tools/check-whitespace.mjs"
  wrote /tmp/class-demo/whitespace-hygiene/h-whitespace-hygiene-2026-11-07T192035-fa876116/rules/no-trailing-whitespace.mjs
  wrote …/rules/no-tabs-in-src.mjs
  wrote …/suite/whitespace-hygiene-guard.mjs
  wrote …/manifest.json
  wrote …/class.json
  wrote …/mutation-matrix.md
  wrote …/README.md

Class whitespace-hygiene revision h-whitespace-hygiene-2026-11-07T192035-fa876116 is red by construction (sha256:1fff0b2a…).
```

What each generated file is for:

- `rules/<id>.mjs` — one stub per rule, `exit 1` with `not implemented` on stdout. The wall runs it with the
  candidate tree as the working directory and reads the exit code: `0` pass, `1` fail, anything else unknown.
- `suite/<class>-guard.mjs` — the visible check's stub: it fails, and it already prints the
  `FACTORY_SUMMARY {"passed":…,"failed":…,"unknown":0,"exitCode":…}` line the wall reads. A suite that exits 0
  without that line is `unknown`, never a pass.
- `class.json` — the declaration the doctor judges: which rule ids exist, which subset the visible check
  enforces, and the mutation matrix (defect → rules that must redden).
- `mutation-matrix.md` — the table to fill with planted defects, one row per rule.
- `manifest.json` — the loader contract: revision name, scenario argv, expected exit codes, and the
  `revisionHash` the loader recomputes. Do not hand-edit the hash; re-run `class new` or recompute it over the
  final scenario list.

The revision name carries the hash of the sources written, so the same arguments rewrite the same revision and a
changed stub is a new one. It also has to sort _after_ every revision already in the class directory: the loader
reads the greatest name, and a class that quietly loses that comparison is a class nobody is measuring. If your
name would lose, `class new` refuses and tells you to pass `--revision`.

## 2. See why it is not authorable yet

```
$ factory class doctor --class whitespace-hygiene --root /tmp/class-demo
CLASS DOCTOR  whitespace-hygiene  revision h-whitespace-hygiene-2026-11-07T192035-fa876116  sha256:1fff0b2a…
  ok     corpus_loads                     corpus … with 2 scenario(s)
  ok     descriptor_present               class.json declares 2 rule(s)
  ok     descriptor_matches_manifest      2 rule(s) declared and run
  FAIL   visible_check_enforces_something visibleRules is empty, so the visible check gives the worker no signal at all
  ok     visible_check_is_strict_subset   visible check enforces 0 of 2 rule(s); invisible: no-trailing-whitespace, no-tabs-in-src
  FAIL   matrix_covers_every_rule         no planted defect reddens no-trailing-whitespace, no-tabs-in-src
  FAIL   matrix_defect_reddens_something  the mutation matrix is empty
  CANNOT bases_red                        no base trees were given …
  CANNOT repair_green                     no repaired tree was given …

3 failed, 2 could not run of 9 check(s) (exit 3).
```

`FAIL` is the class's fault; `CANNOT` is the invocation's. They are never added together, because a run that
could not happen is not a corpus that failed.

## 3. Write the rules, the matrix and the visible subset

1. **Rules.** Replace each stub with the pattern it names. Run it against a tree that must fail and against the
   repaired tree. A rule you cannot make fail is not a rule yet.
2. **Matrix.** Fill `mutation-matrix.md`, then copy the rows into `class.json` as
   `{ "defect": "…", "redRules": ["…"] }`. Every rule must appear in at least one row; a defect that reddens
   nothing is refused by the parser.
3. **Visible subset.** Set `visibleRules` to what the visible check enforces — at least one rule, strictly fewer
   than all of them. Equal to `rules` is refused: the wall would be a mirror, and the class would measure
   whether the worker ran the linter.

## 4. Judge it against real trees

```
factory class doctor --class <class> --root <holdout-root> \
  --repo <mirror.git> --base <sha> [--base <sha>…] --repair <repaired-tree>
```

The doctor extracts each `--base` with `git archive` (so a rule cannot see history, and cannot be satisfied by
it), runs every rule there, and requires **all of them to fail**. Then it runs every rule on `--repair` and
requires **all of them to pass**, and the visible check to pass too. Both halves are necessary: a corpus that
passes a defective tree certifies nothing, and a class whose own repair cannot pass is unrepairable.

Exit codes: `0` authored, `3` the class's contract is wrong, `8` a check could not run (no repo, no repair
tree), `9` the corpus or descriptor is unreadable or lies about its own hash.

## 5. What "authored" does not mean

The doctor checks that the class _can_ discriminate and that its declaration is honest. It cannot check that
the rules are the right rules: that is a judgement about which defects are worth catching, and it belongs in
the class's `README.md` and in the evidence page, in your words. Certification — 20 attempts, a certificate,
money — is the next step and is described in [`certify-class.md`](certify-class.md).
