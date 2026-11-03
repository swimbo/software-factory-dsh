/**
 * The detection half of β: planted regressions that a green visible check cannot see.
 *
 * A certificate's risk is two-sided, and the two sides are different quantities:
 *
 *   - **Power.** With `m` and `k` fixed, a class whose true pass rate is `p` is certified with
 *     probability `P(Bin(m, p) ≥ k)`. That is arithmetic, and it lives in
 *     `packages/wall/src/operating-point.ts` (`certificationRisk`).
 *   - **Detection.** Given a patch that is *actually wrong* — one class rule violated, the visible
 *     check green — does the wall refuse it? That has no closed form. It is a property of the
 *     corpus, so it is measured over a fixed set of planted regressions and reported as a **count**,
 *     never as a rate: a rate over a corpus its own author wrote would be a number quoted as if it
 *     described classes in general.
 *
 * Every tree here is `fixedDocs(index)` — the repair the scripted worker writes — with exactly one
 * repair undone. That is the shape of the candidate the class exists to catch: a competent patch
 * that satisfies everything the worker can check and breaks one rule of the class.
 *
 * Two rules (`no-doubled-words`, `code-fences-balanced`) are also checked by `tools/check-docs.mjs`,
 * so a tree that violates one of them *cannot* have a green visible check: the worker's own oracle
 * sees it first and the holdout sees it again. The other three are invisible to the worker, and
 * those are the detections only the class holdout can make. The spec measures both, and asserts the
 * difference rather than glossing it.
 */
import { fixedDocs, type DocFile } from './docs-substrate.ts';

/**
 * The five rules the class claims, frozen as literals and deliberately **not** derived from
 * `HOLDOUT_RULES`.
 *
 * The corpus is what the wall measures; this list is what the class *says* it measures. If a rule is
 * deleted from the corpus, the regression for it would otherwise pass and silently shrink the
 * count, so the expectation cannot be built from the same list the corpus is built from — the spec's
 * "the corpus measures exactly these five" assertion is what goes red instead.
 */
export const REGRESSION_RULES = [
  'no-doubled-words',
  'relative-links-resolve',
  'headings-unique',
  'code-fences-balanced',
  'no-todo-markers',
] as const;

export type RegressionRule = (typeof REGRESSION_RULES)[number];

/** The two rules the visible check also checks, so their regressions cannot be "visible-green". */
export const VISIBLE_RULES: readonly RegressionRule[] = [
  'no-doubled-words',
  'code-fences-balanced',
];

/**
 * The wall's anonymised handle for a rule: `holdout:NN`, positional over the rules sorted by id.
 *
 * `assessHoldout` (packages/wall/src/evaluate.ts) sorts the corpus scenarios by id and numbers them
 * from 1, so the handle is the rule's alphabetical rank among the five — `holdout:01` is
 * `code-fences-balanced`, `holdout:05` is `relative-links-resolve`. The spec asserts the failing
 * scenario's handle against this, which is what ties a refusal back to the rule that was planted.
 */
export function holdoutHandle(rule: RegressionRule): string {
  const rank = [...REGRESSION_RULES].sort().indexOf(rule);
  if (rank < 0) throw new Error(`regression fixture: unknown rule ${rule}`);
  return `holdout:${String(rank + 1).padStart(2, '0')}`;
}

/**
 * Replace `needle` exactly once, or fail loudly.
 *
 * A fixture that silently edits nothing would produce a *clean* tree, and the spec would then read
 * as "the wall refused a clean repair" — the most misleading possible green. This makes the fixture
 * refuse instead.
 */
function replaceOnce(content: string, needle: string, replacement: string): string {
  const first = content.indexOf(needle);
  if (first < 0 || content.indexOf(needle, first + needle.length) >= 0) {
    throw new Error(
      `regression fixture: expected exactly one occurrence of ${JSON.stringify(needle)}`,
    );
  }
  return content.replace(needle, replacement);
}

interface Defect {
  readonly rule: RegressionRule;
  /** The one file the repair is undone in; every other file stays repaired. */
  readonly path: string;
  readonly apply: (content: string, index: number) => string;
}

const DEFECTS: readonly Defect[] = [
  {
    rule: 'no-doubled-words',
    path: 'docs/index.md',
    // The doubled word the visible check also sees: this regression is refused by the worker's own
    // oracle *and* by the holdout.
    apply: (content) =>
      replaceOnce(
        content,
        'Welcome to the documentation set',
        'Welcome to the the documentation set',
      ),
  },
  {
    rule: 'relative-links-resolve',
    path: 'docs/index.md',
    // The same plausible-but-wrong patch the pipeline spec drives: a link to a file nobody created.
    apply: (content, index) =>
      replaceOnce(content, '](./reference.md)', `](./reference-${index.toString()}.md)`),
  },
  {
    rule: 'headings-unique',
    path: 'docs/guide.md',
    apply: (content) => replaceOnce(content, '## Next steps', '## Steps'),
  },
  {
    rule: 'code-fences-balanced',
    path: 'docs/reference.md',
    // Drop the *closing* fence, or "closing" is a coincidence of where the search landed.
    apply: (content) => replaceOnce(content, 'set the value\n```\n', 'set the value\n'),
  },
  {
    rule: 'no-todo-markers',
    path: 'docs/guide.md',
    apply: (content) => `${content.trimEnd()}\n\nTODO: describe the release process.\n`,
  },
];

function defectOf(rule: RegressionRule): Defect {
  const defect = DEFECTS.find((candidate) => candidate.rule === rule);
  if (defect === undefined) throw new Error(`regression fixture: no defect for rule ${rule}`);
  return defect;
}

/**
 * The repaired tree with `rules` undone.
 *
 * One rule is a single-rule regression; two is the multi-rule control that shows the count is not
 * "one scenario per candidate" by construction. Unknown rule ids throw rather than being skipped.
 */
export function regressionDocs(
  index: number,
  rules: readonly RegressionRule[],
): readonly DocFile[] {
  if (rules.length === 0) throw new Error('regression fixture: at least one rule is required');
  let docs: readonly DocFile[] = fixedDocs(index);
  for (const rule of rules) {
    const defect = defectOf(rule);
    let applied = false;
    docs = docs.map((file) => {
      if (file.path !== defect.path) return file;
      applied = true;
      return { path: file.path, content: defect.apply(file.content, index) };
    });
    if (!applied) {
      throw new Error(`regression fixture: ${rule} edits ${defect.path}, which the tree lacks`);
    }
  }
  return docs;
}
