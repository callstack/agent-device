/**
 * #1478 P5 step 2: cell 5 — winner and matched-node domain from the same
 * selector alternative.
 *
 * `classifyReplayTarget` composes `resolveSelectorChain` (the winner) with a
 * matched-node domain it computes over `resolved.selector` — the SAME chain
 * alternative resolution picked, not the first alternative with any match at
 * all. The future `resolveRecordedTarget` port operation "internally composes
 * parse/resolve/list-matches/match" (issue comment 5156017698) and must
 * protect this exact invariant, since `matchCount`/the identity-set domain
 * feed decision-3 classification (`classifyTargetBindingMatch`) directly.
 *
 * The fixture is deliberately hostile to the naive implementation: the first
 * alternative is genuinely ambiguous (three-way tie, so resolution SKIPS it
 * rather than picking a heuristic winner), and the second is unique. A domain
 * computed from `listSelectorChainMatches` (which mirrors "first alternative
 * with ANY match", independent of whether resolution could use it) would
 * report matchCount 3 from the skipped first alternative instead of 1 from
 * the alternative resolution actually used.
 */
import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { TargetAnnotationV1 } from '@agent-device/contracts/replay';
import { classifyReplayTarget } from '../session-replay-target-classification.ts';
import { toSnapshotNodes } from './session-replay-target-classification-fixtures.ts';

const PLATFORM = 'ios' as const;

// Three "Decoy" buttons: the first two exactly tie (same depth/area), the
// third is uniquely deepest and smallest, so the deepest-then-smallest
// heuristic picks it decisively — an unresolvable tie would fall through to
// the second alternative regardless of `allowDisambiguation`, which is not
// what cell 5's contrast test needs.
function decoyAndSaveTree() {
  return toSnapshotNodes([
    {
      index: 0,
      type: 'Button',
      label: 'Decoy',
      rect: { x: 0, y: 0, width: 40, height: 20 },
      depth: 1,
    },
    {
      index: 1,
      type: 'Button',
      label: 'Decoy',
      rect: { x: 60, y: 0, width: 40, height: 20 },
      depth: 1,
    },
    {
      index: 2,
      type: 'Button',
      label: 'Decoy',
      rect: { x: 120, y: 0, width: 20, height: 10 },
      depth: 3,
    },
    {
      index: 3,
      type: 'Button',
      identifier: 'save',
      label: 'Save',
      rect: { x: 0, y: 40, width: 40, height: 20 },
      depth: 1,
    },
  ]);
}

function saveRecorded(overrides: Partial<TargetAnnotationV1> = {}): TargetAnnotationV1 {
  return {
    role: 'button',
    label: 'Save',
    ancestry: [],
    sibling: 3,
    viewportOrder: 0,
    verification: 'verified',
    ...overrides,
  };
}

test('P5 port cell 5: matchCount/domain come from the resolved alternative, not the first alternative with any match', () => {
  const nodes = decoyAndSaveTree();
  const result = classifyReplayTarget({
    recorded: saveRecorded(),
    token: 'label="Decoy" || id="save"',
    nodes,
    platform: PLATFORM,
    refLabel: undefined,
    requireRect: true,
    // Disambiguation disabled: the first alternative's 3-way tie has no
    // heuristic winner, so resolution must skip it for the unique second one.
    allowDisambiguation: false,
  });

  assert.equal(result.verified, true);
  if (!result.verified) throw new Error('unreachable');
  assert.equal(result.winnerNode.ref, 'e4');
  // The load-bearing assertion: 1 (the "id=save" domain), never 3 (the
  // skipped "label=Decoy" domain).
  assert.equal(result.matchCount, 1);
});

test('P5 port cell 5: with disambiguation enabled, a resolvable first alternative supplies its OWN full domain, not the second alternative it never tries', () => {
  // Contrast case: the third "Decoy" is uniquely deepest, so disambiguation
  // resolves the first alternative directly (resolution never reaches
  // "id=save" at all). Classification's domain must be the first
  // alternative's own 3-way match count, not 1 (what the second alternative
  // would have produced).
  const nodes = decoyAndSaveTree();
  const result = classifyReplayTarget({
    recorded: { ...saveRecorded(), role: 'button', label: 'Decoy', sibling: 2 },
    token: 'label="Decoy" || id="save"',
    nodes,
    platform: PLATFORM,
    refLabel: undefined,
    requireRect: true,
    allowDisambiguation: true,
  });

  assert.equal(result.verified, true);
  if (!result.verified) throw new Error('unreachable');
  assert.equal(result.winnerNode.ref, 'e3');
  // The load-bearing assertion: 3 (the "label=Decoy" domain resolution
  // actually used), never 1 (the untried "id=save" domain).
  assert.equal(result.matchCount, 3);
});
