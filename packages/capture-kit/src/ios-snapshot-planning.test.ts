import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'vitest';
import type {
  CaptureHint,
  IosSnapshotAcquisitionProducerCapabilities,
  IosSnapshotComparisonIdentity,
  IosSnapshotInput,
  IosSnapshotRequestInput,
} from '@agent-device/contracts/ios-snapshot';
import {
  areIosSnapshotComparisonIdentitiesEqual,
  buildIosSnapshotComparisonIdentity,
  buildIosSnapshotPresentationKey,
  createIosSnapshotRequest,
  deriveIosCaptureHint,
  planIosSnapshot,
} from '@agent-device/capture-kit/ios-snapshot-planning';
import {
  createIosSnapshotAcquisition,
  IOS_SNAPSHOT_PRODUCER_CAPABILITIES,
} from '@agent-device/capture-kit/ios-snapshot-acquisition';

type CaptureHintFixture = Readonly<{
  name: string;
  request: IosSnapshotRequestInput;
  expected: CaptureHint;
}>;

const TABLE_PATH = path.resolve(
  import.meta.dirname,
  '..',
  '..',
  '..',
  'contracts',
  'fixtures',
  'ios-snapshot-capture-hint.json',
);

test('the request-to-capture-hint table is exhaustive', () => {
  const fixtures = JSON.parse(fs.readFileSync(TABLE_PATH, 'utf8')) as CaptureHintFixture[];
  assert.ok(fixtures.length > 0, 'capture-hint table must not be empty');
  assert.equal(new Set(fixtures.map((fixture) => fixture.name)).size, fixtures.length);
  for (const fixture of fixtures) {
    const request = createIosSnapshotRequest(fixture.request);
    assert.deepEqual(deriveIosCaptureHint(request), fixture.expected, fixture.name);
  }
});

test('normalization makes raw, scope, and absent values explicit', () => {
  const request = createIosSnapshotRequest({
    raw: true,
    depth: 2,
    scope: '  Card  ',
    acquisitionIntent: 'surface-observation',
  });
  assert.deepEqual(request, {
    projection: 'raw',
    interactiveOnly: false,
    depth: 2,
    scope: 'Card',
    customActions: false,
    acquisitionIntent: 'surface-observation',
  });
  assert.deepEqual(buildIosSnapshotPresentationKey(request), {
    projection: 'raw',
    interactiveOnly: false,
    depth: 2,
    scope: 'Card',
    customActions: false,
  });
});

test('depth narrowing requires complete support for the requested projection', () => {
  const rawRequest = createIosSnapshotRequest({ projection: 'raw', depth: 2 });
  const regularRequest = createIosSnapshotRequest({ projection: 'regular', depth: 2 });
  const rawComplete = acquiredProducer({
    acquisitionDepth: {
      rawTraversal: { kind: 'complete' },
      regularPresented: { kind: 'incomplete' },
    },
  });
  const rawIncomplete = acquiredProducer({
    acquisitionDepth: {
      rawTraversal: { kind: 'incomplete' },
      regularPresented: { kind: 'incomplete' },
    },
  });
  assert.equal(planIosSnapshot(rawRequest, rawComplete).narrowing.depth, 2);
  assert.equal(planIosSnapshot(rawRequest, rawIncomplete).narrowing.depth, null);

  const regularComplete = acquiredProducer({
    acquisitionDepth: {
      rawTraversal: { kind: 'complete' },
      regularPresented: { kind: 'complete', maxDepth: 2 },
    },
  });
  const regularTooShallow = acquiredProducer({
    acquisitionDepth: {
      rawTraversal: { kind: 'complete' },
      regularPresented: { kind: 'complete', maxDepth: 1 },
    },
  });
  assert.equal(planIosSnapshot(regularRequest, regularComplete).narrowing.depth, 2);
  assert.equal(planIosSnapshot(regularRequest, regularTooShallow).narrowing.depth, null);
});

test('scoped acquisition remains broad and reports scope completeness as evidence', () => {
  const request = createIosSnapshotRequest({ projection: 'regular', depth: 2, scope: 'Card' });
  const complete = acquiredProducer({ scopeCompleteness: 'complete' });
  const incomplete = acquiredProducer({ scopeCompleteness: 'incomplete' });
  assert.deepEqual(planIosSnapshot(request, complete).narrowing, {
    depth: null,
    scope: null,
    interactiveOnly: false,
  });
  assert.equal(planIosSnapshot(request, complete).evidence.scope, 'complete');
  assert.equal(planIosSnapshot(request, incomplete).evidence.scope, 'incomplete');
});

test('interactive narrowing requires complete queries and available hittability', () => {
  const request = createIosSnapshotRequest({ interactiveOnly: true });
  const complete = acquiredProducer({
    interactiveQueryCompleteness: 'complete',
    hittabilityEvidence: 'available',
  });
  const incompleteQuery = acquiredProducer({
    interactiveQueryCompleteness: 'incomplete',
    hittabilityEvidence: 'available',
  });
  const missingHittability = acquiredProducer({
    interactiveQueryCompleteness: 'complete',
    hittabilityEvidence: 'unavailable',
  });
  assert.equal(planIosSnapshot(request, complete).narrowing.interactiveOnly, true);
  assert.equal(planIosSnapshot(request, incompleteQuery).narrowing.interactiveOnly, false);
  assert.equal(planIosSnapshot(request, missingHittability).narrowing.interactiveOnly, false);
});

test('presented producers cannot claim acquisition narrowing', () => {
  const request = createIosSnapshotRequest({ projection: 'regular', depth: 2 });
  const plan = planIosSnapshot(request, IOS_SNAPSHOT_PRODUCER_CAPABILITIES['apple-runner']);
  assert.deepEqual(plan.narrowing, { depth: null, scope: null, interactiveOnly: false });
  assert.deepEqual(plan.evidence, {
    scope: 'complete',
    interactiveQuery: 'complete',
    viewport: 'available',
    hittability: 'available',
    truncation: 'available',
  });
});

test('Appium source plan carries its viewport evidence capability', () => {
  const plan = planIosSnapshot(
    createIosSnapshotRequest(),
    IOS_SNAPSHOT_PRODUCER_CAPABILITIES['appium-source'],
  );
  assert.equal(plan.evidence.viewport, 'available');
});

test('acquisition derives unavailable Appium facts from the registry', () => {
  assert.deepEqual(
    createIosSnapshotAcquisition({
      producer: 'appium-source',
      nodes: [],
      viewport: { kind: 'reported', rect: { x: 0, y: 0, width: 1, height: 1 } },
      lineage: {},
    }).acquisition.residue,
    [
      { kind: 'unavailable-fact', fact: 'hittability' },
      { kind: 'unavailable-fact', fact: 'acquisition-depth' },
      { kind: 'unavailable-fact', fact: 'truncation' },
    ],
  );
});

test('comparison identity rejects every identity axis and residue mismatch', () => {
  const base = comparisonIdentity();
  const mismatches: IosSnapshotComparisonIdentity[] = [
    { ...base, producer: 'limrun-ios-tree' },
    { ...base, intent: 'surface-observation' },
    { ...base, lineage: { targetId: 'simulator-1', generation: 'generation-2' } },
    { ...base, presentationKey: { ...base.presentationKey, depth: 1 } },
    { ...base, residue: [{ kind: 'truncated', dimension: 'nodes' }] },
  ];
  assert.equal(areIosSnapshotComparisonIdentitiesEqual(base, { ...base }), true);
  assert.equal(
    areIosSnapshotComparisonIdentitiesEqual(base, {
      ...base,
      residue: [{ kind: 'provider-pruned', fields: ['scope', 'nodes'] }],
    }),
    false,
  );
  for (const mismatch of mismatches) {
    assert.equal(areIosSnapshotComparisonIdentitiesEqual(base, mismatch), false);
  }
  assert.equal(
    areIosSnapshotComparisonIdentitiesEqual(
      { ...base, residue: [{ kind: 'provider-pruned', fields: ['scope', 'nodes'] }] },
      { ...base, residue: [{ kind: 'provider-pruned', fields: ['nodes', 'scope'] }] },
    ),
    true,
  );
});

test('comparison identity builder follows the closed input stage', () => {
  const request = createIosSnapshotRequest({ acquisitionIntent: 'surface-observation' });
  const acquired: IosSnapshotInput = {
    stage: 'acquired',
    acquisition: {
      producer: 'simulator-ax-bridge',
      intent: 'surface-observation',
      hint: {
        ...deriveIosCaptureHint(request),
        acquisitionIntent: 'surface-observation',
      },
      nodes: [],
      truncated: false,
      viewport: { kind: 'reported', rect: { x: 0, y: 0, width: 10, height: 10 } },
      lineage: { targetId: 'simulator-1', generation: 'generation-1' },
      residue: [],
    },
  };
  assert.deepEqual(buildIosSnapshotComparisonIdentity(acquired, request), {
    producer: 'simulator-ax-bridge',
    intent: 'surface-observation',
    lineage: { targetId: 'simulator-1', generation: 'generation-1' },
    presentationKey: {
      projection: 'regular',
      interactiveOnly: false,
      depth: null,
      scope: null,
      customActions: false,
    },
    residue: [],
  });
});

function acquiredProducer(
  overrides: Partial<Omit<IosSnapshotAcquisitionProducerCapabilities, 'producer' | 'stage'>> = {},
): IosSnapshotAcquisitionProducerCapabilities {
  return {
    producer: 'simulator-ax-bridge',
    stage: 'acquired',
    acquisitionDepth: {
      rawTraversal: { kind: 'complete' },
      regularPresented: { kind: 'complete' },
    },
    scopeCompleteness: 'incomplete',
    interactiveQueryCompleteness: 'incomplete',
    viewportEvidence: 'available',
    hittabilityEvidence: 'available',
    truncationEvidence: 'available',
    presentationOwner: 'snapshot-state',
    ...overrides,
  };
}

function comparisonIdentity(
  overrides: Partial<IosSnapshotComparisonIdentity> = {},
): IosSnapshotComparisonIdentity {
  return {
    producer: 'simulator-ax-bridge',
    intent: 'full',
    lineage: { targetId: 'simulator-1', generation: 'generation-1' },
    presentationKey: {
      projection: 'regular',
      interactiveOnly: false,
      depth: null,
      scope: null,
      customActions: false,
    },
    residue: [],
    ...overrides,
  };
}
