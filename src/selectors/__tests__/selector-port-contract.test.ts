/**
 * #1478 P5 step 2: behavior pins for the future `packages/ad-replay` selector
 * port (approved amendment, issue comment 5156017698 — `readSelectorExpression`
 * / `resolveRecordedTarget` / `buildSelectorCandidates`). These tests exercise
 * today's root `src/selectors` implementation directly and are NOT the port
 * itself — they exist so a port that changes any of these outcomes fails
 * loudly instead of silently drifting.
 *
 * Four cells live here, all reachable through `resolveSelectorChain` /
 * `listSelectorChainMatches` / `tryParseSelectorChain` — the primitives
 * `resolveRecordedTarget` will internally compose:
 *
 *   1. invalid selector vs valid-but-no-match (distinguishable shapes)
 *   2. fallback-alternative selection (first alternative has zero matches)
 *   3. ambiguity with and without a disambiguation tiebreak
 *   4. `requireRect` excluding an otherwise-matching, rect-less node
 */
import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { SnapshotState } from '@agent-device/kernel/snapshot';
import {
  listSelectorChainMatches,
  parseSelectorChain,
  resolveSelectorChain,
  tryParseSelectorChain,
} from '../index.ts';

const saveButtonNodes: SnapshotState['nodes'] = [
  {
    ref: 'e1',
    index: 0,
    type: 'Button',
    label: 'Save',
    rect: { x: 0, y: 0, width: 40, height: 20 },
    enabled: true,
    hittable: true,
  },
];

// ---------------------------------------------------------------------------
// Cell 1: invalid selector vs valid-but-no-match
// ---------------------------------------------------------------------------

test('P5 port cell 1: an invalid selector expression and a valid-but-unmatched one fail through different, non-interchangeable shapes', () => {
  // Invalid: the parser itself refuses. `tryParseSelectorChain` never
  // produces a chain to resolve against — there is no matched-node domain.
  const invalid = tryParseSelectorChain('foo=bar');
  assert.equal(invalid, null);
  assert.throws(() => parseSelectorChain('foo=bar'), /Unknown selector key/i);

  // Valid but unmatched: the parser succeeds (a real SelectorChain, with
  // `.raw`/`.selectors`), and only `resolveSelectorChain` — a DIFFERENT
  // function — reports the zero-match outcome, also as null.
  const valid = tryParseSelectorChain('label="Ghost"');
  assert.notEqual(valid, null);
  assert.equal(valid?.raw, 'label="Ghost"');
  assert.equal(valid?.selectors.length, 1);
  assert.doesNotThrow(() => parseSelectorChain('label="Ghost"'));

  const resolved = resolveSelectorChain(saveButtonNodes, valid!, {
    platform: 'ios',
    requireUnique: true,
  });
  assert.equal(resolved, null);

  // The two failures are reachable through DIFFERENT functions on the same
  // input path: a caller (the future `readSelectorExpression`) must check
  // parse validity before ever calling `resolveSelectorChain`
  // (`resolveRecordedTarget`'s job) — collapsing them into one null would
  // lose the "is this expression well-formed at all" signal callers like
  // `session-replay-target-verification.ts` depend on.
});

// ---------------------------------------------------------------------------
// Cell 2: fallback-alternative selection
// ---------------------------------------------------------------------------

test('P5 port cell 2: a later alternative wins when an earlier one has zero matches', () => {
  const chain = parseSelectorChain('id="missing" || label="Save"');
  const resolved = resolveSelectorChain(saveButtonNodes, chain, {
    platform: 'ios',
    requireUnique: true,
  });
  assert.ok(resolved);
  assert.equal(resolved.selectorIndex, 1);
  assert.equal(resolved.node.ref, 'e1');
  assert.deepEqual(
    resolved.diagnostics.map((entry) => entry.matches),
    [0, 1],
  );
});

// ---------------------------------------------------------------------------
// Cell 3: ambiguity with and without disambiguation
// ---------------------------------------------------------------------------

function twoWayTieNodes(): SnapshotState['nodes'] {
  return [
    {
      ref: 'e1',
      index: 0,
      type: 'Button',
      label: 'Press me',
      rect: { x: 0, y: 0, width: 300, height: 300 },
      depth: 1,
      enabled: true,
      hittable: true,
    },
    {
      ref: 'e2',
      index: 1,
      type: 'Button',
      label: 'Press me',
      rect: { x: 10, y: 10, width: 100, height: 20 },
      depth: 2,
      enabled: true,
      hittable: true,
    },
  ];
}

test('P5 port cell 3: the SAME ambiguous match is null without a tiebreak and a disclosed winner with one', () => {
  const nodes = twoWayTieNodes();
  const chain = parseSelectorChain('label="Press me"');

  const withoutTiebreak = resolveSelectorChain(nodes, chain, {
    platform: 'ios',
    requireRect: true,
    requireUnique: true,
  });
  assert.equal(withoutTiebreak, null);

  const withTiebreak = resolveSelectorChain(nodes, chain, {
    platform: 'ios',
    requireRect: true,
    requireUnique: true,
    disambiguateAmbiguous: true,
  });
  assert.ok(withTiebreak);
  assert.equal(withTiebreak.node.ref, 'e2');
  assert.equal(withTiebreak.matches, 2);
  assert.equal(withTiebreak.disambiguation?.tiebreak, 'deepest');
  assert.equal(withTiebreak.disambiguation?.matchCount, 2);
  assert.deepEqual(
    withTiebreak.disambiguation?.alternatives.map((node) => node.ref),
    ['e1'],
  );
});

// ---------------------------------------------------------------------------
// Cell 4: requireRect
// ---------------------------------------------------------------------------

test('P5 port cell 4: requireRect excludes an otherwise-matching node with no usable rect, consistently across resolve and list-matches', () => {
  const rectlessNodes: SnapshotState['nodes'] = [
    { ref: 'e1', index: 0, type: 'Button', label: 'Ghost row', enabled: true },
  ];
  const chain = parseSelectorChain('label="Ghost row"');

  const withRectRequired = resolveSelectorChain(rectlessNodes, chain, {
    platform: 'ios',
    requireRect: true,
    requireUnique: true,
  });
  assert.equal(withRectRequired, null);

  const withoutRectRequired = resolveSelectorChain(rectlessNodes, chain, {
    platform: 'ios',
    requireRect: false,
    requireUnique: true,
  });
  assert.ok(withoutRectRequired);
  assert.equal(withoutRectRequired.node.ref, 'e1');

  // The future `resolveRecordedTarget` composes `resolveSelectorChain` (the
  // winner) with `listSelectorChainMatches` (the domain, #1478 amendment's
  // "same alternative" invariant) — both must apply the SAME rect policy, or
  // the domain could disagree with a winner the policy already excluded.
  const matchList = listSelectorChainMatches(rectlessNodes, chain, {
    platform: 'ios',
    requireRect: true,
  });
  assert.equal(matchList, null);
});
