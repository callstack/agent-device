import { test } from 'vitest';
import assert from 'node:assert/strict';
import { coveredInteractionDetails } from './interaction-error.ts';

const scanCoveredNode = {
  ref: 'e2',
  interactionBlocked: 'covered' as const,
  coveredBy: {
    kind: 'dialog',
    label: 'Automation sheet',
    rect: { x: 0, y: 330, width: 390, height: 554 },
  },
};

const policyCoveredNode = {
  ref: 'e7',
  interactionBlocked: 'covered' as const,
};

test('coveredInteractionDetails names the cover the scan found and keys the refusal by reason', () => {
  assert.deepEqual(coveredInteractionDetails(scanCoveredNode), {
    reason: 'target_covered',
    hint: 'Covered by the dialog "Automation sheet" at (0, 330 390x554). Dismiss or close that element, scroll the target clear of it, or inspect with snapshot/screenshot before retrying.',
    ref: '@e2',
    interactionBlocked: 'covered',
    coveredBy: scanCoveredNode.coveredBy,
  });
});

test('coveredInteractionDetails carries no selector unless the refusal was selector-addressed', () => {
  assert.equal(coveredInteractionDetails(scanCoveredNode).selector, undefined);
  assert.equal(
    coveredInteractionDetails(scanCoveredNode, { selector: 'label=Save draft' }).selector,
    'label=Save draft',
  );
});

test('coveredInteractionDetails keeps the generic recovery for a policy-covered node', () => {
  // A backend-policy cover reports a boolean and names no culprit, so the detail omits `coveredBy`
  // rather than guessing one, and the hint stays the generic recovery.
  const details = coveredInteractionDetails(policyCoveredNode);
  assert.equal('coveredBy' in details, false);
  assert.equal(details.interactionBlocked, 'covered');
  assert.equal(
    details.hint,
    'Use a different visible target, scroll it clear of the overlay, or inspect with snapshot/screenshot before retrying.',
  );
});

test('coveredInteractionDetails never advertises the cover as an actionable ref', () => {
  const details = coveredInteractionDetails(scanCoveredNode);
  assert.equal(details.ref, '@e2');
  assert.deepEqual(Object.keys(details.coveredBy!), ['kind', 'label', 'rect']);
});

test('the hint rounds cover geometry and stays one line for an app-controlled label', () => {
  // The label is app-controlled text, so only the rendering is sanitized — the detail keeps it raw.
  const hint = String(
    coveredInteractionDetails({
      ref: 'e2',
      interactionBlocked: 'covered',
      coveredBy: {
        kind: 'tab-bar',
        label: '  Dismiss\n  "now"  ',
        rect: { x: 0.4, y: 760.2, width: 390.5, height: 84 },
      },
    }).hint,
  );
  assert.match(
    hint,
    /^Covered by the tab-bar "Dismiss now" at \(0, 760 391x84\)\. Dismiss or close/,
  );
  assert.doesNotMatch(hint, /\n/);
});

test('the hint falls back to the bare kind when the label sanitizes to nothing', () => {
  const hint = String(
    coveredInteractionDetails({
      ref: 'e2',
      interactionBlocked: 'covered',
      coveredBy: { kind: 'tab-bar', label: '""\n', rect: { x: 0, y: 760, width: 390, height: 84 } },
    }).hint,
  );
  assert.match(hint, /^Covered by the tab-bar at \(0, 760 390x84\)/);
});

test('the hint names a cover the capture published without a rect', () => {
  const hint = String(
    coveredInteractionDetails({
      ref: 'e2',
      interactionBlocked: 'covered',
      coveredBy: { kind: 'sheet' },
    }).hint,
  );
  assert.match(hint, /^Covered by the sheet\. Dismiss or close that element/);
});
