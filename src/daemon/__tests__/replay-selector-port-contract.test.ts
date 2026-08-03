/**
 * #1478 P5 stage B: the `ReplaySelectorPort` contract (issue comment
 * 5156017698's amendment), run against BOTH adapters — the production
 * adapter (`../replay-selector-port.ts`, delegating to `src/selectors`) and
 * the deterministic in-memory adapter
 * (`../../__tests__/test-utils/in-memory-replay-selector-port.ts`, relocated
 * there in P5 stage D). This suite lives in root, not in `packages/ad-replay`,
 * because only root can import the production adapter (R11 package-boundaries:
 * a workspace package may never reach back into root `src/`) — the same
 * reason the in-memory adapter itself had to move to root once this was its
 * only consumer.
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
import { createInMemoryReplaySelectorPort } from '../../__tests__/test-utils/in-memory-replay-selector-port.ts';
import { createDaemonReplaySelectorPort } from '../replay-selector-port.ts';

const ADAPTERS: readonly (readonly [string, () => ReplaySelectorPort])[] = [
  ['production (src/selectors)', createDaemonReplaySelectorPort],
  ['in-memory (test-utils)', createInMemoryReplaySelectorPort],
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
    // cell 6 shared-id (#1269 binding amendment): id demotion
    // -------------------------------------------------------------------
    test('cell 6 shared-id: an id that denotes more than one node in the record-time tree is dropped from the candidate list, not just reordered', () => {
      const dup: SnapshotNode = {
        ref: 'e1',
        index: 0,
        type: 'Button',
        identifier: 'dup',
        label: 'Save Draft',
        rect: { x: 0, y: 0, width: 80, height: 30 },
      };
      const otherDup: SnapshotNode = {
        ref: 'e2',
        index: 1,
        type: 'Button',
        identifier: 'dup',
        label: 'Cancel',
        rect: { x: 0, y: 40, width: 80, height: 30 },
      };
      const candidates = port.buildSelectorCandidates(dup, 'ios', {
        action: 'get',
        nodes: [dup, otherDup],
      });
      assert.deepEqual(candidates, ['role="button" label="Save Draft"', 'label="Save Draft"']);
      assert.ok(
        !candidates.some((candidate) => candidate.startsWith('id=')),
        'a non-unique id must never appear in the candidate list',
      );
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

    // -------------------------------------------------------------------
    // readSelectorExpression: 'ordinary' bare-token 'invalid' reachability
    // -------------------------------------------------------------------
    // #1555 structural-quality review ("verify both adapters' readSelectorExpression
    // handle a bare token identically"): `packages/ad-replay/src/internal/target-verification.ts`'s
    // `planPreDispatchTargetVerification` now calls
    // `port.readSelectorExpression('ordinary', [token])` as its parse gate
    // (replacing an empty-tree `resolveRecordedTarget` call). The two
    // adapters do NOT agree on the exact discriminant for a token that LOOKS
    // selector-shaped (contains a recognized `key=`) but fails to parse:
    //
    //  - production's 'ordinary' grammar (`splitSelectorFromArgs`) only ever
    //    records a candidate boundary once `tryParseSelectorChain` has
    //    already succeeded on it — a single already-whole token that never
    //    parses at any prefix length contributes NO boundary at all, so the
    //    call falls through to 'not-applicable'. 'invalid' is structurally
    //    unreachable from a single-token 'ordinary' call.
    //  - the in-memory mini-grammar checks "looks selector-shaped" and
    //    "parses" as two separate steps and reports 'invalid' the moment the
    //    first shaped candidate fails the second, which a single malformed
    //    token ('id=' — a recognized key with no value) reaches directly.
    //
    // This is a real, load-bearing simplification of the mini adapter (its
    // own module comment already discloses several grammar-richness gaps),
    // not a bug: `planPreDispatchTargetVerification` treats every
    // non-'expression' outcome identically (skip pre-dispatch verification),
    // so the two adapters still agree on the ONE thing that call site
    // observes. This cell pins the exact (diverging) discriminant per
    // adapter so a future change to either grammar cannot silently widen the
    // gap without failing here first.
    test("readSelectorExpression: 'ordinary' bare token that looks selector-shaped but fails to parse", () => {
      const outcome = port.readSelectorExpression('ordinary', ['id=']);
      if (name.startsWith('production')) {
        assert.deepEqual(outcome, { kind: 'not-applicable' });
      } else {
        assert.deepEqual(outcome, { kind: 'invalid' });
      }
      // Both discriminants are still members of the "not a parseable
      // expression" set the one real call site treats identically.
      assert.notEqual(outcome.kind, 'expression');
    });
  });
}
