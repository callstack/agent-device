/**
 * #1478 P5 stage B: the `ReplaySelectorPort` contract (issue comment
 * 5156017698's amendment), run against BOTH adapters — the production
 * adapter (`../replay-selector-port.ts`, delegating to `src/selectors`) and
 * the package's deterministic in-memory adapter
 * (`@agent-device/ad-replay/testing`). This suite lives in root, not in
 * `packages/ad-replay`, because only root can import the production adapter
 * (R11 package-boundaries: a workspace package may never reach back into
 * root `src/`).
 *
 * Every scenario below is expressed in the in-memory adapter's documented
 * mini expression grammar (`key="value"` terms, ` || ` alternatives, keys
 * `id`/`label`/`role`/`value`/`text`) — a literal subset of the real
 * `src/selectors` grammar, so identical inputs produce identical outcomes on
 * both adapters. Fixtures deliberately avoid an `Application`/`Window`
 * ancestor (matching `selector-port-contract.test.ts` and
 * `session-replay-target-classification-port.test.ts`'s own flat fixtures),
 * so on-screen-visibility never enters the deepest/smallest-area tiebreak.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import type { SnapshotNode } from '@agent-device/kernel/snapshot';
import type { ReplaySelectorPort } from '@agent-device/ad-replay';
import { createInMemoryReplaySelectorPort } from '@agent-device/ad-replay/testing';
import { createDaemonReplaySelectorPort } from '../replay-selector-port.ts';

const ADAPTERS: readonly (readonly [string, () => ReplaySelectorPort])[] = [
  ['production (src/selectors)', createDaemonReplaySelectorPort],
  ['in-memory (packages/ad-replay testing)', createInMemoryReplaySelectorPort],
];

const saveNode: SnapshotNode = {
  ref: 'e1',
  index: 0,
  type: 'Button',
  label: 'Save',
  rect: { x: 0, y: 0, width: 40, height: 20 },
  enabled: true,
  hittable: true,
};

function twoWayTieNodes(): SnapshotNode[] {
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

function decoyAndSaveTree(): SnapshotNode[] {
  return [
    {
      ref: 'e1',
      index: 0,
      type: 'Button',
      label: 'Decoy',
      rect: { x: 0, y: 0, width: 40, height: 20 },
      depth: 1,
    },
    {
      ref: 'e2',
      index: 1,
      type: 'Button',
      label: 'Decoy',
      rect: { x: 60, y: 0, width: 40, height: 20 },
      depth: 1,
    },
    {
      ref: 'e3',
      index: 2,
      type: 'Button',
      label: 'Decoy',
      rect: { x: 120, y: 0, width: 20, height: 10 },
      depth: 3,
    },
    {
      ref: 'e4',
      index: 3,
      type: 'Button',
      identifier: 'save',
      label: 'Save',
      rect: { x: 0, y: 40, width: 40, height: 20 },
      depth: 1,
    },
  ];
}

for (const [name, createPort] of ADAPTERS) {
  describe(`ReplaySelectorPort contract: ${name}`, () => {
    const port = createPort();

    // -------------------------------------------------------------------
    // resolveRecordedTarget cell 1: invalid-expression vs valid-no-match
    // -------------------------------------------------------------------
    test('cell 1: an unknown selector key is parse-invalid, a well-formed selector with nothing matching is no-match', () => {
      const invalid = port.resolveRecordedTarget('foo="bar"', [saveNode], {
        platform: 'ios',
        requireRect: false,
        allowDisambiguation: false,
      });
      assert.deepEqual(invalid, { kind: 'unresolved', reason: 'parse-invalid', matchedNodes: [] });

      const noMatch = port.resolveRecordedTarget('label="Ghost"', [saveNode], {
        platform: 'ios',
        requireRect: false,
        allowDisambiguation: false,
      });
      assert.equal(noMatch.kind, 'unresolved');
      if (noMatch.kind !== 'unresolved') throw new Error('unreachable');
      assert.equal(noMatch.reason, 'no-match');
      assert.deepEqual(noMatch.matchedNodes, []);
    });

    // -------------------------------------------------------------------
    // cell 2: fallback-alternative selection
    // -------------------------------------------------------------------
    test('cell 2: a later alternative wins when an earlier one has zero matches', () => {
      const result = port.resolveRecordedTarget('id="missing" || label="Save"', [saveNode], {
        platform: 'ios',
        requireRect: false,
        allowDisambiguation: false,
      });
      assert.equal(result.kind, 'resolved');
      if (result.kind !== 'resolved') throw new Error('unreachable');
      assert.equal(result.winner.ref, 'e1');
      assert.equal(result.matchCount, 1);
    });

    // -------------------------------------------------------------------
    // cell 3: ambiguity with and without a disambiguation tiebreak
    // -------------------------------------------------------------------
    test('cell 3: the SAME ambiguous match is unresolved without a tiebreak and a disclosed winner with one', () => {
      const nodes = twoWayTieNodes();
      const withoutTiebreak = port.resolveRecordedTarget('label="Press me"', nodes, {
        platform: 'ios',
        requireRect: true,
        allowDisambiguation: false,
      });
      assert.equal(withoutTiebreak.kind, 'unresolved');
      if (withoutTiebreak.kind !== 'unresolved') throw new Error('unreachable');
      assert.equal(withoutTiebreak.reason, 'ambiguous');
      assert.equal(withoutTiebreak.matchedNodes.length, 2);

      const withTiebreak = port.resolveRecordedTarget('label="Press me"', nodes, {
        platform: 'ios',
        requireRect: true,
        allowDisambiguation: true,
      });
      assert.equal(withTiebreak.kind, 'resolved');
      if (withTiebreak.kind !== 'resolved') throw new Error('unreachable');
      assert.equal(withTiebreak.winner.ref, 'e2');
      assert.equal(withTiebreak.matchCount, 2);
      assert.equal(withTiebreak.disambiguation?.tiebreak, 'deepest');
      assert.equal(withTiebreak.disambiguation?.matchCount, 2);
      assert.deepEqual(
        withTiebreak.disambiguation?.alternatives.map((node) => node.ref),
        ['e1'],
      );
    });

    // -------------------------------------------------------------------
    // cell 4: requireRect
    // -------------------------------------------------------------------
    test('cell 4: requireRect excludes an otherwise-matching node with no usable rect, consistently on both the winner and the domain', () => {
      const rectlessNodes: SnapshotNode[] = [
        { ref: 'e1', index: 0, type: 'Button', label: 'Ghost row', enabled: true },
      ];

      const withRectRequired = port.resolveRecordedTarget('label="Ghost row"', rectlessNodes, {
        platform: 'ios',
        requireRect: true,
        allowDisambiguation: false,
      });
      assert.equal(withRectRequired.kind, 'unresolved');
      if (withRectRequired.kind !== 'unresolved') throw new Error('unreachable');
      assert.equal(withRectRequired.reason, 'no-match');
      assert.deepEqual(withRectRequired.matchedNodes, []);

      const withoutRectRequired = port.resolveRecordedTarget('label="Ghost row"', rectlessNodes, {
        platform: 'ios',
        requireRect: false,
        allowDisambiguation: false,
      });
      assert.equal(withoutRectRequired.kind, 'resolved');
      if (withoutRectRequired.kind !== 'resolved') throw new Error('unreachable');
      assert.equal(withoutRectRequired.winner.ref, 'e1');
    });

    // -------------------------------------------------------------------
    // cell 5: winner and matched-node domain from the SAME alternative
    // -------------------------------------------------------------------
    test("cell 5: allowDisambiguation off skips a RESOLVABLE first alternative, using the second alternative's own domain", () => {
      const result = port.resolveRecordedTarget('label="Decoy" || id="save"', decoyAndSaveTree(), {
        platform: 'ios',
        requireRect: true,
        allowDisambiguation: false,
      });
      assert.equal(result.kind, 'resolved');
      if (result.kind !== 'resolved') throw new Error('unreachable');
      assert.equal(result.winner.ref, 'e4');
      // Load-bearing: 1 (the "id=save" domain), never 3 (the skipped "label=Decoy" domain).
      assert.equal(result.matchCount, 1);
    });

    test('cell 5: the SAME fixture with allowDisambiguation on resolves through the first alternative and uses ITS domain instead', () => {
      const result = port.resolveRecordedTarget('label="Decoy" || id="save"', decoyAndSaveTree(), {
        platform: 'ios',
        requireRect: true,
        allowDisambiguation: true,
      });
      assert.equal(result.kind, 'resolved');
      if (result.kind !== 'resolved') throw new Error('unreachable');
      assert.equal(result.winner.ref, 'e3');
      // Load-bearing: 3 (the "label=Decoy" domain resolution actually used), never 1.
      assert.equal(result.matchCount, 3);
      assert.equal(result.disambiguation?.tiebreak, 'deepest');
    });

    // -------------------------------------------------------------------
    // cell 6 (amendment cell 8): repair-suggestion ordering
    // -------------------------------------------------------------------
    test('cell 6: a node with id, role+label, label, and value all present suggests them id > role+label > label > value', () => {
      const node: SnapshotNode = {
        ref: 'e1',
        index: 0,
        type: 'Button',
        identifier: 'save-btn',
        label: 'Save Draft',
        value: 'Draft',
        rect: { x: 0, y: 0, width: 80, height: 30 },
      };
      const candidates = port.buildSelectorCandidates(node, 'ios', {
        action: 'get',
        nodes: [node],
      });
      assert.deepEqual(candidates, [
        'id="save-btn"',
        'role="button" label="Save Draft"',
        'label="Save Draft"',
        'value="Draft"',
      ]);
    });

    // -------------------------------------------------------------------
    // readSelectorExpression: shape parity for the two reachable outcomes
    // -------------------------------------------------------------------
    test('readSelectorExpression: an ordinary selector token round-trips, absent selector is not-applicable', () => {
      const found = port.readSelectorExpression('ordinary', ['label=Save']);
      assert.deepEqual(found, { kind: 'expression', expression: 'label=Save', rest: [] });

      const absent = port.readSelectorExpression('ordinary', ['hello']);
      assert.deepEqual(absent, { kind: 'not-applicable' });

      const emptyIs = port.readSelectorExpression('is', ['visible']);
      assert.deepEqual(emptyIs, { kind: 'not-applicable' });

      const isExpression = port.readSelectorExpression('is', ['visible', 'label=Save']);
      assert.deepEqual(isExpression, { kind: 'expression', expression: 'label=Save', rest: [] });
    });
  });
}
