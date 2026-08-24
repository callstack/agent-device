import assert from 'node:assert/strict';
import { resolveSelectorChainWithPolicy } from './engine.ts';
import { test } from 'vitest';
import type { SnapshotNode } from '@agent-device/kernel/snapshot';
import * as selectorsFacade from './index.ts';
import * as selectorsEngine from './engine.ts';
import {
  buildSelectorCandidates,
  readReplaySelectorDisplayValue,
  readSelectorExpression,
  resolveRecordedTarget,
  resolveReplaySuggestionCandidate,
  SELECTOR_RESOLUTION_POLICIES,
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

/**
 * Counts whole-array traversals of the snapshot tree: `for...of` passes through
 * the iterator, plus every array scan layered on top of them. The scan list is
 * the whole surface, not just the methods the resolver happens to use today, so
 * a regression that reintroduces a full pass through `flatMap`/`forEach`/
 * `reduce`/`some` cannot slip past a counter that only watches `filter`/`map`.
 * Functions are bound to the target so a counted traversal cannot re-enter the
 * proxy.
 */
const SCAN_METHODS = [
  'filter',
  'map',
  'flatMap',
  'forEach',
  'reduce',
  'reduceRight',
  'some',
  'every',
  'find',
  'findIndex',
  'findLast',
  'findLastIndex',
  'includes',
  'indexOf',
] as const;
type ScanMethod = (typeof SCAN_METHODS)[number];
type ScanPasses = { iterated: number } & Record<ScanMethod, number>;

function observeTreeTraversals(nodes: SnapshotNode[]): {
  observed: SnapshotNode[];
  passes: ScanPasses;
} {
  const passes = Object.fromEntries([
    ['iterated', 0],
    ...SCAN_METHODS.map((method) => [method, 0]),
  ]) as ScanPasses;
  const observed = new Proxy(nodes, {
    get(target, property) {
      if (property === Symbol.iterator) passes.iterated += 1;
      for (const method of SCAN_METHODS) if (property === method) passes[method] += 1;
      const value = Reflect.get(target, property) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { observed, passes };
}

test('recorded-target resolution adds no second matching pass per selector alternative', () => {
  const nodes: SnapshotNode[] = [
    { ...saveNode, ref: 'e1', label: 'Decoy', identifier: undefined, depth: 1 },
    { ...saveNode, ref: 'e2', label: 'Decoy', identifier: undefined, depth: 1 },
    { ...saveNode, ref: 'e4', label: 'Save', identifier: 'save', depth: 1 },
  ];

  const resolved = observeTreeTraversals(nodes);
  resolveRecordedTarget('id="missing" || id="save"', resolved.observed, policy());
  // One matching pass per alternative tried, and no further pass rebuilding the
  // winner's matched-node domain that the deciding pass already collected.
  assert.deepEqual(resolved.passes, {
    iterated: 2,
    filter: 0,
    map: 0,
    flatMap: 0,
    forEach: 0,
    reduce: 0,
    reduceRight: 0,
    some: 0,
    every: 0,
    find: 0,
    findIndex: 0,
    findLast: 0,
    findLastIndex: 0,
    includes: 0,
    indexOf: 0,
  });

  const unresolved = observeTreeTraversals(nodes);
  resolveRecordedTarget('label="Decoy"', unresolved.observed, policy());
  // The ambiguous leg reports that same domain instead of re-listing the chain's
  // matches: one matching pass, no second one. The `map` is the deciding pass's
  // own lazily-built visibility index. The `flatMap`s are NOT that pass — they
  // are four whole-tree viewport-rect scans per ambiguous candidate, charged by
  // `isNodeVisibleOnScreen` because the caller passes no precomputed viewport
  // rects. They scale with the candidate count and predate this change; they are
  // pinned here so the number cannot grow unnoticed, and are tracked separately.
  assert.deepEqual(unresolved.passes, {
    iterated: 1,
    filter: 0,
    map: 1,
    flatMap: 8,
    forEach: 0,
    reduce: 0,
    reduceRight: 0,
    some: 0,
    every: 0,
    find: 0,
    findIndex: 0,
    findLast: 0,
    findLastIndex: 0,
    includes: 0,
    indexOf: 0,
  });
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

  const resolved = resolveSelectorChainWithPolicy(
    [saveNode],
    'id="save"',
    SELECTOR_RESOLUTION_POLICIES.act,
    { platform: 'ios' },
  );
  assert.equal(resolved.kind, 'resolved');
  assert.equal(resolved.kind === 'resolved' ? resolved.resolution.selector : null, 'id="save"');
});

/**
 * #1630 made `resolveSelectorChainWithPolicy` the façade's ONLY resolution
 * entry: a native caller states its ambiguity contract by naming a policy row
 * because there is no knob-taking or count-only resolver here to state it
 * inline with instead.
 *
 * This guard is structural on purpose. Restoring either removed lookup is
 * BEHAVIOURALLY invisible — `findSelectorChainMatch` is equivalent to the
 * `readAny` row it was migrated to, which is exactly why that migration
 * preserved semantics — so no fixture-tree assertion can catch a revert
 * (#1715 review). The absence of the symbol is the only observable.
 */
test('the façade exposes no resolver at all, and the engine door exposes only the two entries', () => {
  const exported = Object.keys(selectorsFacade);
  // #1656 moved both engine entries behind `./engine`, which R19 reserves for
  // the selector-pipeline owner: a route that could reach a resolver from the
  // root façade would get an ambiguity contract while skipping every
  // structural stage its policy row declares.
  assert.ok(
    !exported.includes('resolveSelectorChainWithPolicy'),
    'resolution belongs to the engine subpath, behind the pipeline owner',
  );
  assert.ok(
    !exported.includes('listSelectorChainMatches'),
    'enumeration belongs to the engine subpath, behind the pipeline owner',
  );
  assert.deepEqual(Object.keys(selectorsEngine).sort(), [
    'listSelectorChainMatches',
    'resolveSelectorChainWithPolicy',
  ]);

  // Unchanged since #1630, on both surfaces: neither door hands out a knob
  // resolver a call site could rebuild its contract from.
  for (const [surface, names] of [
    ['facade', exported],
    ['engine', Object.keys(selectorsEngine)],
  ] as const) {
    assert.ok(!names.includes('resolveSelectorChain'), `${surface}: knob-taking resolver`);
    assert.ok(
      !names.includes('findSelectorChainMatch'),
      `${surface}: count-only existence lookup; \`is exists\` names the readAny row`,
    );
    assert.ok(!names.includes('selectorResolutionKnobs'), `${surface}: knob derivation`);
  }
});
