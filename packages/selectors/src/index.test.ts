import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { SnapshotNode } from '@agent-device/kernel/snapshot';
import {
  buildSelectorCandidates,
  readReplaySelectorDisplayValue,
  readSelectorExpression,
  resolveRecordedTarget,
  resolveReplaySuggestionCandidate,
  resolveSelectorChain,
} from './index.ts';

const saveNode: SnapshotNode = {
  ref: 'e1',
  index: 0,
  type: 'Button',
  label: 'Save',
  identifier: 'save',
  rect: { x: 0, y: 0, width: 40, height: 20 },
  enabled: true,
  hittable: true,
};

function policy(overrides: Partial<Parameters<typeof resolveRecordedTarget>[2]> = {}) {
  return {
    platform: 'ios' as const,
    requireRect: true,
    allowDisambiguation: false,
    ...overrides,
  };
}

test('replay expression reading preserves the dispatch grammar outcomes', () => {
  assert.deepEqual(readSelectorExpression('positional', ['label=Save']), {
    kind: 'expression',
    expression: 'label=Save',
    rest: [],
  });
  assert.deepEqual(readSelectorExpression('is', ['visible', 'label=Save']), {
    kind: 'expression',
    expression: 'label=Save',
    rest: [],
  });
  assert.deepEqual(readSelectorExpression('positional', ['hello']), { kind: 'not-applicable' });
  assert.notEqual(readSelectorExpression('positional', ['id=']).kind, 'expression');
});

test('recorded-target resolution distinguishes parse failure, no match, fallback, and ambiguity', () => {
  assert.deepEqual(resolveRecordedTarget('foo="bar"', [saveNode], policy()), {
    kind: 'unresolved',
    reason: 'parse-invalid',
    matchedNodes: [],
  });
  assert.deepEqual(resolveRecordedTarget('label="Ghost"', [saveNode], policy()), {
    kind: 'unresolved',
    reason: 'no-match',
    matchedNodes: [],
  });

  const fallback = resolveRecordedTarget('id="missing" || label="Save"', [saveNode], policy());
  assert.equal(fallback.kind, 'resolved');
  if (fallback.kind !== 'resolved') throw new Error('unreachable');
  assert.equal(fallback.winner.ref, 'e1');
  assert.equal(fallback.matchCount, 1);

  const ambiguousNodes: SnapshotNode[] = [
    { ...saveNode, ref: 'e1', label: 'Press me', identifier: undefined, depth: 1 },
    {
      ...saveNode,
      ref: 'e2',
      label: 'Press me',
      identifier: undefined,
      depth: 2,
      rect: { x: 10, y: 10, width: 10, height: 10 },
    },
  ];
  const unresolved = resolveRecordedTarget('label="Press me"', ambiguousNodes, policy());
  assert.equal(unresolved.kind, 'unresolved');
  if (unresolved.kind !== 'unresolved') throw new Error('unreachable');
  assert.equal(unresolved.reason, 'ambiguous');
  assert.equal(unresolved.matchedNodes.length, 2);

  const disambiguated = resolveRecordedTarget(
    'label="Press me"',
    ambiguousNodes,
    policy({ allowDisambiguation: true }),
  );
  assert.equal(disambiguated.kind, 'resolved');
  if (disambiguated.kind !== 'resolved') throw new Error('unreachable');
  assert.equal(disambiguated.winner.ref, 'e2');
  assert.equal(disambiguated.matchCount, 2);
  assert.equal(disambiguated.disambiguation?.tiebreak, 'deepest');
});

test('recorded-target resolution keeps the matched domain from the alternative that won', () => {
  const nodes: SnapshotNode[] = [
    { ...saveNode, ref: 'e1', label: 'Decoy', identifier: undefined, depth: 1 },
    { ...saveNode, ref: 'e2', label: 'Decoy', identifier: undefined, depth: 1 },
    {
      ...saveNode,
      ref: 'e3',
      label: 'Decoy',
      identifier: undefined,
      depth: 3,
      rect: { x: 120, y: 0, width: 20, height: 10 },
    },
    { ...saveNode, ref: 'e4', label: 'Save', identifier: 'save', depth: 1 },
  ];

  const strict = resolveRecordedTarget('label="Decoy" || id="save"', nodes, policy());
  assert.equal(strict.kind, 'resolved');
  if (strict.kind !== 'resolved') throw new Error('unreachable');
  assert.equal(strict.winner.ref, 'e4');
  assert.equal(strict.matchCount, 1);

  const permissive = resolveRecordedTarget(
    'label="Decoy" || id="save"',
    nodes,
    policy({ allowDisambiguation: true }),
  );
  assert.equal(permissive.kind, 'resolved');
  if (permissive.kind !== 'resolved') throw new Error('unreachable');
  assert.equal(permissive.winner.ref, 'e3');
  assert.equal(permissive.matchCount, 3);
});

test('recorded-target resolution applies requireRect to both winner and domain', () => {
  const rectless: SnapshotNode = { ...saveNode, label: 'Ghost row', rect: undefined };
  const required = resolveRecordedTarget('label="Ghost row"', [rectless], policy());
  assert.deepEqual(required, { kind: 'unresolved', reason: 'no-match', matchedNodes: [] });

  const optional = resolveRecordedTarget(
    'label="Ghost row"',
    [rectless],
    policy({ requireRect: false }),
  );
  assert.equal(optional.kind, 'resolved');
  if (optional.kind !== 'resolved') throw new Error('unreachable');
  assert.equal(optional.winner.ref, 'e1');
});

test('candidate generation preserves priority and demotes shared ids', () => {
  const node: SnapshotNode = {
    ...saveNode,
    identifier: 'save-btn',
    label: 'Save Draft',
    value: 'Draft',
    rect: { x: 0, y: 0, width: 80, height: 30 },
  };
  assert.deepEqual(buildSelectorCandidates(node, 'ios', { action: 'get', nodes: [node] }), [
    'id="save-btn"',
    'role="button" label="Save Draft"',
    'label="Save Draft"',
    'value="Draft"',
  ]);

  const duplicate = { ...node, ref: 'e2', label: 'Cancel', identifier: 'save-btn' };
  const candidates = buildSelectorCandidates(node, 'ios', {
    action: 'get',
    nodes: [node, duplicate],
  });
  assert.deepEqual(candidates, [
    'role="button" label="Save Draft"',
    'label="Save Draft"',
    'value="Draft"',
  ]);
});

test('replay suggestion resolution and display values stay string-only at the façade', () => {
  const suggestion = resolveReplaySuggestionCandidate(
    'role="button" label="Save"',
    [saveNode],
    policy({ allowDisambiguation: true }),
  );
  assert.equal(suggestion?.node.ref, 'e1');
  assert.equal(suggestion?.basis, 'role-label');
  assert.equal(readReplaySelectorDisplayValue('label="Save"'), 'Save');
  assert.equal(readReplaySelectorDisplayValue('label="Save" || label="Draft"'), undefined);

  const resolved = resolveSelectorChain([saveNode], 'id="save"', {
    platform: 'ios',
    requireRect: true,
    requireUnique: true,
  });
  assert.equal(resolved?.selector, 'id="save"');
  assert.equal(typeof resolved?.selector, 'string');
});
