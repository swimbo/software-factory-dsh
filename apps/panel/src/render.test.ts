/**
 * The rendered page — every rule the specification states about the HTML, asserted
 * against the bytes the server would actually send.
 *
 * The tests fall into four groups: the structure an operator must always find
 * (three regions, the budget, the Δ table), the honesty rules (`unknown` never
 * dressed as a pass, no zero where a measurement is missing), the constraints that
 * make the page safe (no script, no network, no form, escaped text), and the
 * refusal pages that must appear instead of a guess.
 */
import { describe, expect, it } from 'vitest';

import type { StatusV1 } from '@factory/contracts';

import {
  escapeHtml,
  renderNotFoundHtml,
  renderRefusalHtml,
  renderStatusPage,
  renderUnauthorizedHtml,
} from './render.ts';
import { sampleStatus } from '../test/fixtures.ts';

const render = (status: StatusV1): string => renderStatusPage(status);

describe('structure', () => {
  it('always carries the three regions, the budget and the Δ table', () => {
    const html = render(sampleStatus());
    expect(html).toContain('NEEDS YOU');
    expect(html).toContain('WORKING');
    expect(html).toContain('RECENT VERDICTS');
    expect(html).toContain('BUDGET');
    expect(html).toContain('Δ BY TASK CLASS');
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('<html lang="en">');
  });

  it('says an empty section is empty instead of hiding it', () => {
    const html = render(sampleStatus({ verdict: 'passed' }));
    expect(html).toContain('nothing needs you');
    expect(html).toContain('nothing in flight');
  });

  it('opens with a one-line answer before any detail', () => {
    const html = render(sampleStatus({ verdict: 'passed' }));
    expect(html).toContain('0 need you · 0 working');
  });

  it('is deterministic — the same status renders to the same bytes', () => {
    const status = sampleStatus({ verdict: 'unknown' });
    expect(render(status)).toBe(render(status));
  });

  it('shows the pinned DSH version and the observed one separately', () => {
    const html = render(sampleStatus());
    expect(html).toContain('dsh 0.2.1-rc.3');
    expect(html).toContain('observed unknown');
  });
});

describe('read-only and self-contained', () => {
  const html = render(sampleStatus({ verdict: 'unknown' }));

  it('contains no interactive element at all', () => {
    expect(html).not.toMatch(/<button/i);
    expect(html).not.toMatch(/<input/i);
    expect(html).not.toMatch(/<form/i);
    expect(html).not.toMatch(/<textarea/i);
    expect(html).not.toMatch(/<select/i);
    // No script, inline or external: nothing on this page can act.
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/onclick=/i);
  });

  it('loads nothing from the network', () => {
    expect(html).not.toMatch(/https?:\/\//i);
    expect(html).not.toContain('<link');
    expect(html).not.toMatch(/@import/);
    expect(html).not.toMatch(/url\(/);
    expect(html).not.toContain('fetch(');
  });

  it('escapes every dynamic string, so a title cannot become markup', () => {
    const html = render(sampleStatus({ title: '<script>alert(1)</script>' }));
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('escapes the five characters that matter', () => {
    expect(escapeHtml(`<&>"'`)).toBe('&lt;&amp;&gt;&quot;&#39;');
  });
});

describe('unknown is a value, never a pass', () => {
  const html = render(sampleStatus({ verdict: 'unknown' }));

  it('renders the unknown verdict with its word, its glyph and its reason', () => {
    expect(html).toContain('[?]');
    expect(html).toContain('UNKNOWN');
    expect(html).toContain('not a pass');
    expect(html).toContain('holdout_unavailable');
  });

  it('counts an unknown unit as needing a person (ux-plan A-1)', () => {
    // The aggregate may never read "0 need you" while an unknown exists.
    expect(html).toContain('1 need you');
    expect(html).toContain('1 unknown (not a pass)');
    expect(html).not.toContain('0 need you');
  });

  it('prints `unknown` for unmeasured telemetry instead of a zero or a dash', () => {
    const working = render(sampleStatus({ verdict: 'none' }));
    expect(working).toContain('turn unknown');
    expect(working).toContain('tokens unknown/unknown');
    expect(working).not.toMatch(/tokens 0\/0/);
    expect(working).not.toContain('tokens —');
  });

  it('prints the measured turn count once a receipt exists', () => {
    // `turnsUsed` is the one telemetry figure a receipt really holds; token counts
    // have no source at all, so they stay unknown even here.
    const measured = render(sampleStatus({ verdict: 'passed' }));
    expect(measured).toContain('turn 6');
    expect(measured).not.toContain('turn unknown');
  });

  it('never paints an unknown state in the ok colour', () => {
    const html = render(sampleStatus({ verdict: 'unknown' }));
    expect(html).toContain('class="pill pill--unknown"');
    // The ok chip exists only for real passes; an UNKNOWN word inside it would be
    // the exact false green the page exists to prevent.
    for (const match of html.matchAll(/class="pill pill--ok"[\s\S]{0,120}?<\/span>/g)) {
      expect(match[0]).not.toContain('UNKNOWN');
    }
  });

  it('writes Δ as the literal word when no measurement exists', () => {
    const htmlWithUnknown = render(sampleStatus({ verdict: 'unknown' }));
    expect(htmlWithUnknown).toContain('Δ unknown');
    expect(htmlWithUnknown).not.toContain('Δ 0.00');
  });
});

describe('the health strip', () => {
  it('is absent entirely when every subsystem is ok', () => {
    const html = render(sampleStatus({ healthAllOk: true }));
    expect(html).not.toContain('HEALTH');
    expect(html).not.toContain('class="health');
  });

  it('is present and worst-first when something is not ok', () => {
    const html = render(sampleStatus({ verdict: 'unknown' }));
    const wall = html.indexOf('WALL UNAVAILABLE');
    const dsh = html.indexOf('DSH VERSION UNAVAILABLE');
    expect(wall).toBeGreaterThan(-1);
    expect(dsh).toBeGreaterThan(wall);
    // The rest of the strip is a second line, and it says when it started.
    expect(html).toContain('since 2026-11-01T12:10:00.000Z');
    expect(html).toContain('CONTROL PLANE ok');
    expect(html).toContain('OUTBOX ok');
  });

  it('leads with a store that is quarantined, and says what that means', () => {
    const html = render(sampleStatus({ quarantined: true }));
    expect(html.indexOf('STORE UNAVAILABLE')).toBeGreaterThan(-1);
    expect(html.indexOf('STORE UNAVAILABLE')).toBeLessThan(html.indexOf('WALL'));
    expect(html).toContain('STORE QUARANTINED');
    expect(html).toContain('read-only');
    expect(html).toContain('docs/runbooks/store-quarantine.md');
  });
});

describe('the budget', () => {
  it('states the figure with `estimated` next to it', () => {
    const html = render(sampleStatus({ healthAllOk: true }));
    expect(html).toContain('~$6.41 of $20.00, estimated');
    expect(html).toContain('per-unit $2.00, estimated');
    expect(html).toContain('price table p3');
  });

  it('marks spend understated with a gap when a unit is unmeasured', () => {
    const html = render(sampleStatus({ healthAllOk: true, budgetUnknownCount: 2 }));
    expect(html).toContain('~$6.41+');
    expect(html).toContain('spend understated');
    expect(html).toContain('meter__gap');
    expect(html).toContain('spend unknown for 2 units');
    expect(html).not.toContain('~$6.41 of');
  });

  it('draws the estimated share as a dashed segment, not only as a colour', () => {
    const html = render(sampleStatus({ healthAllOk: true }));
    expect(html).toContain('meter__estimated');
    expect(html).toContain('meter__measured');
  });
});

describe('the Δ table', () => {
  it('has one row per task class and never a blended row', () => {
    const html = render(sampleStatus({ verdict: 'passed' }));
    expect(html).toContain('code-change');
    expect(html).toContain('config-change');
    expect(html).toContain('one row per task class; Δ is never blended across classes.');
    expect(html).not.toContain('all tasks');
    expect(html).not.toContain('blended Δ');
  });

  it('refuses to claim stability from a single sample', () => {
    const html = render(sampleStatus({ verdict: 'passed' }));
    expect(html).toContain('unstable (n&lt;5)');
    expect(html).not.toContain('>stable<');
  });

  it('reports escape rate as unknown with no samples', () => {
    const html = render(sampleStatus({ verdict: 'passed' }));
    expect(html).toContain('escape unknown (no samples)');
  });
});

describe('recent verdicts', () => {
  it('caps the list at five', () => {
    const html = render(sampleStatus({ extraVerdictUnits: 9 }));
    expect(html).toContain('RECENT VERDICTS <span class="meta">5</span>');
  });

  it('shows the receipt, the holdout count and the open signature gate', () => {
    const html = render(sampleStatus({ verdict: 'passed' }));
    expect(html).toContain('receipt R-0aa1');
    expect(html).toContain('holdout 2/2');
    expect(html).toContain('promotion: first promotion requires your signature');
    expect(html).toContain('signed unknown');
  });
});

describe('the refusal pages', () => {
  it('names the header and the query parameter on 401', () => {
    const html = renderUnauthorizedHtml(
      'a token is required: send `Authorization: Bearer <token>` or open the page with `?token=<token>`',
    );
    expect(html).toContain('401 UNAUTHORIZED');
    expect(html).toContain('Authorization: Bearer &lt;token&gt;');
    expect(html).toContain('?token=');
  });

  it('refuses to draw a status that failed validation', () => {
    const html = renderRefusalHtml(['units.0.verdict.delta.state: Invalid enum value']);
    expect(html).toContain('STATUS FAILED VALIDATION');
    expect(html).toContain('units.0.verdict.delta.state');
    expect(html).toContain('will not draw a status object');
  });

  it('answers an unknown route without pretending a page exists', () => {
    const html = renderNotFoundHtml('/units');
    expect(html).toContain('404 NOT FOUND');
    expect(html).toContain('/units');
  });
});
