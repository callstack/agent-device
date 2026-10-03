import assert from 'node:assert/strict';
import fc from 'fast-check';
import { test } from 'vitest';
import type {
  IosSnapshotAcquisition,
  IosSnapshotInput,
  IosSnapshotRequest,
  IosSnapshotValidationFacts,
} from '@agent-device/contracts/ios-snapshot';
import type { RawSnapshotNode } from '@agent-device/kernel/snapshot';
import {
  buildIosSnapshotPresentationKey,
  createIosSnapshotRequest,
  deriveIosCaptureHint,
} from '@agent-device/capture-kit/ios-snapshot-planning';
import { canonicalNodes, runTypeScriptCase } from './conformance-harness.ts';
import { differentialBatchArbitrary } from './conformance-generator.ts';
import { acquisitionForGoldenCase, readIosSnapshotEngineFixture } from './conformance-fixture.ts';
import { IosSnapshotEngineError, presentIosSnapshot, publishIosSnapshot } from './index.ts';

test('property: regular effective geometry stays within the viewport and actionability fails closed', () => {
  fc.assert(fc.property(differentialBatchArbitrary, assertRegularCases), {
    seed: 219105,
    numRuns: 100,
  });
});

test('property: an unscoped, unlimited raw presentation preserves every reported frame', () => {
  fc.assert(fc.property(differentialBatchArbitrary, assertRawCases), {
    seed: 219106,
    numRuns: 100,
  });
});

test('property: interactive is a subset of regular, and regular is a subset of raw', () => {
  fc.assert(fc.property(differentialBatchArbitrary, assertProjectionSubsets), {
    seed: 219107,
    numRuns: 100,
  });
});

test('property: unavailable hittability fails closed without changing comparison identity', () => {
  const fixture = readIosSnapshotEngineFixture();
  const testCase = fixture.cases.find(
    (entry) => entry.name === 'unavailable hittability fails closed',
  );
  assert.ok(testCase);
  const request = createIosSnapshotRequest({ projection: 'regular' });
  const acquisition = acquisitionForRequest(acquisitionForGoldenCase(fixture, testCase), request);
  const input: IosSnapshotInput = { stage: 'acquired', acquisition };
  const presentation = presentIosSnapshot(input, request, { foldPolicy: testCase.foldPolicy });
  assert.ok(presentation.nodes.every((node) => node.hittable !== true));

  const publication = publishIosSnapshot(input, request, { foldPolicy: testCase.foldPolicy });
  assert.deepEqual(publication.comparisonIdentity.lineage, acquisition.lineage);
  assert.deepEqual(publication.comparisonIdentity.residue, acquisition.residue);
  assert.deepEqual(publication.residue, acquisition.residue);
});

test('property: runner validation distinguishes an invalid quality payload', () => {
  const fixture = readIosSnapshotEngineFixture();
  const testCase = fixture.cases.find(
    (entry) => entry.name === 'nested ancestor clips and actionability',
  );
  assert.ok(testCase);
  const request = createIosSnapshotRequest({ projection: 'regular' });
  const acquisition = acquisitionForRequest(acquisitionForGoldenCase(fixture, testCase), request);
  const acquired = publishIosSnapshot({ stage: 'acquired', acquisition }, request, {
    foldPolicy: testCase.foldPolicy,
  });
  const validation: IosSnapshotValidationFacts = {
    presentationKey: buildIosSnapshotPresentationKey(request),
    viewport: acquisition.viewport,
    hittability: { kind: 'available' },
    lineage: acquisition.lineage,
    residue: acquisition.residue,
  };
  const input: IosSnapshotInput = {
    stage: 'presented',
    presentation: {
      producer: 'apple-runner',
      intent: 'full',
      payload: { nodes: acquired.payload.nodes, truncated: false },
      qualityPayload: {
        nodes: [
          {
            ...acquired.payload.nodes[0]!,
            rect: { x: 0, y: 0, width: 321, height: 240 },
          },
        ],
        truncated: false,
        scope: null,
      },
    },
    validation,
  };
  assert.throws(
    () => presentIosSnapshot(input, request, { foldPolicy: testCase.foldPolicy }),
    (error: unknown) =>
      error instanceof IosSnapshotEngineError && error.reason === 'invalid-quality-payload',
  );
});

type DifferentialCase = Parameters<typeof runTypeScriptCase>[0];
type DifferentialNode = ReturnType<typeof runTypeScriptCase>['nodes'][number];

function assertProjectionSubsets(cases: readonly DifferentialCase[]): void {
  for (const testCase of cases) {
    const regularRequest = createIosSnapshotRequest({ projection: 'regular' });
    const interactiveRequest = createIosSnapshotRequest({
      projection: 'regular',
      interactiveOnly: true,
    });
    const rawRequest = createIosSnapshotRequest({ projection: 'raw' });
    const acquisition = acquisitionForDifferentialCase(testCase, regularRequest);
    const regular = presentIosSnapshot({ stage: 'acquired', acquisition }, regularRequest, {
      foldPolicy: testCase.foldPolicy,
    });
    const interactive = presentIosSnapshot(
      {
        stage: 'acquired',
        acquisition: acquisitionForRequest(acquisition, interactiveRequest),
      },
      interactiveRequest,
      { foldPolicy: testCase.foldPolicy },
    );
    const raw = presentIosSnapshot(
      { stage: 'acquired', acquisition: acquisitionForRequest(acquisition, rawRequest) },
      rawRequest,
      { foldPolicy: testCase.foldPolicy },
    );
    assertMultisetSubset(nodeIdentities(interactive.nodes), nodeIdentities(regular.nodes));
    assertMultisetSubset(nodeIdentities(regular.nodes), nodeIdentities(raw.nodes));
  }
}

function assertMultisetSubset(subset: readonly string[], superset: readonly string[]): void {
  const remaining = new Map<string, number>();
  for (const identity of superset) remaining.set(identity, (remaining.get(identity) ?? 0) + 1);
  for (const identity of subset) {
    const count = remaining.get(identity) ?? 0;
    assert.ok(count > 0, identity);
    remaining.set(identity, count - 1);
  }
}

function nodeIdentities(nodes: readonly RawSnapshotNode[]): string[] {
  return nodes.map((node) =>
    JSON.stringify([node.label ?? null, node.identifier ?? null, node.value ?? null]),
  );
}

function acquisitionForDifferentialCase(
  testCase: DifferentialCase,
  request: IosSnapshotRequest,
): IosSnapshotAcquisition {
  const fullRequest = requireFullRequest(request);
  return {
    producer: 'simulator-ax-bridge',
    intent: fullRequest.acquisitionIntent,
    hint: {
      ...deriveIosCaptureHint(fullRequest),
      acquisitionIntent: fullRequest.acquisitionIntent,
    },
    nodes: testCase.nodes,
    truncated: false,
    viewport: { kind: 'reported', rect: testCase.viewport },
    lineage: { targetId: 'property-target', generation: 'property-generation' },
    residue: [],
  };
}

function acquisitionForRequest(
  acquisition: IosSnapshotAcquisition,
  request: IosSnapshotRequest,
): IosSnapshotAcquisition {
  const fullRequest = requireFullRequest(request);
  return {
    producer: acquisition.producer,
    intent: fullRequest.acquisitionIntent,
    hint: {
      ...deriveIosCaptureHint(fullRequest),
      acquisitionIntent: fullRequest.acquisitionIntent,
    },
    nodes: acquisition.nodes,
    truncated: acquisition.truncated,
    viewport: acquisition.viewport,
    lineage: acquisition.lineage,
    residue: acquisition.residue,
  };
}

type FullSnapshotRequest = IosSnapshotRequest & { acquisitionIntent: 'full' };

function requireFullRequest(request: IosSnapshotRequest): FullSnapshotRequest {
  if (request.acquisitionIntent !== 'full') {
    throw new Error('property fixtures require full acquisition');
  }
  return request as FullSnapshotRequest;
}

function assertRegularCases(cases: readonly DifferentialCase[]): void {
  for (const testCase of cases) assertRegularCase(testCase);
}

function assertRegularCase(testCase: DifferentialCase): void {
  const result = runTypeScriptCase(testCase);
  assert.equal(result.outcome, 'success');
  if (testCase.projection === 'raw') return;
  for (const node of result.nodes) assertRegularNode(node, testCase.viewport);
}

function assertRegularNode(node: DifferentialNode, viewport: DifferentialCase['viewport']): void {
  assertRect(node, viewport);
  assertActionability(node, viewport);
  assertParentOrder(node);
}

function assertRect(node: DifferentialNode, viewport: DifferentialCase['viewport']): void {
  if (!node.rect) return;
  assert.ok(node.rect.width >= 0 && node.rect.height >= 0);
  if (node.rect.width > 0 && node.rect.height > 0) assertRectWithinViewport(node.rect, viewport);
}

function assertRectWithinViewport(
  rect: NonNullable<DifferentialNode['rect']>,
  viewport: DifferentialCase['viewport'],
): void {
  assert.ok(rect.x >= viewport.x - 0.0001);
  assert.ok(rect.y >= viewport.y - 0.0001);
  assert.ok(rect.x + rect.width <= viewport.x + viewport.width + 0.0001);
  assert.ok(rect.y + rect.height <= viewport.y + viewport.height + 0.0001);
}

function assertActionability(node: DifferentialNode, viewport: DifferentialCase['viewport']): void {
  if (!node.hittable) return;
  assert.ok(node.rect && node.rect.width > 0 && node.rect.height > 0);
  const centerX = node.rect.x + node.rect.width / 2;
  const centerY = node.rect.y + node.rect.height / 2;
  assert.ok(centerX >= viewport.x && centerX <= viewport.x + viewport.width);
  assert.ok(centerY >= viewport.y && centerY <= viewport.y + viewport.height);
}

function assertParentOrder(node: DifferentialNode): void {
  if (node.parentIndex !== null) assert.ok(node.parentIndex < node.index);
}

function assertRawCases(cases: readonly DifferentialCase[]): void {
  for (const testCase of cases) {
    const rawCase = {
      ...testCase,
      name: testCase.name + '-raw',
      projection: 'raw' as const,
      depth: null,
      scope: null,
    };
    const result = runTypeScriptCase(rawCase);
    assert.equal(result.outcome, 'success');
    assert.deepEqual(result.nodes, canonicalNodes(testCase.nodes));
  }
}
