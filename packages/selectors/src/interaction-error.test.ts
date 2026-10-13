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
  assert.match(String(details.hint), /different visible target/i);
});

test('coveredInteractionDetails never advertises the cover as an actionable ref', () => {
  const details = coveredInteractionDetails(scanCoveredNode);
  assert.equal(details.ref, '@e2');
  assert.deepEqual(Object.keys(details.coveredBy!), ['kind', 'label', 'rect']);
});
