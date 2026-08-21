import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertSnapshotBackendConformance,
  createSnapshotBackendConformanceTransport,
  loadSnapshotBackendConformanceFixture,
} from './ios-simulator-e2e/snapshot-backend-conformance.ts';
import {
  buildSnapshotBackendConformanceBase,
  type SnapshotBackendConformanceInput,
} from './ios-simulator-e2e/snapshot-backend-conformance-fixtures.ts';

const fixture = loadSnapshotBackendConformanceFixture();

test('snapshot backend conformance checks each backend contract independently', () => {
  const base = buildSnapshotBackendConformanceBase();

  assert.doesNotThrow(() => assertSnapshotBackendConformance(base, 'tree', fixture));
  assert.throws(
    () =>
      assertSnapshotBackendConformance(
        { ...base, snapshotQuality: { state: 'healthy', backend: 'tree' } },
        'private-ax',
        fixture,
      ),
    /private-ax capture must prove its backend/,
  );
});

test('snapshot backend conformance rejects every promised control invariant', () => {
  const base = buildSnapshotBackendConformanceBase();
  const updateControl = (identifier: string, update: Record<string, unknown>) =>
    base.nodes.map((node) => (node.identifier === identifier ? { ...node, ...update } : node));
  const expectFailure = (
    name: string,
    snapshot: SnapshotBackendConformanceInput,
    message: RegExp,
  ) =>
    assert.throws(() => assertSnapshotBackendConformance(snapshot, 'tree', fixture), message, name);

  expectFailure(
    'sparse quality',
    { ...base, snapshotQuality: { state: 'sparse', backend: 'tree' } },
    /must have a non-sparse quality verdict/,
  );
  expectFailure(
    'recovered/truncated mismatch',
    { ...base, truncated: true },
    /quality\/truncation/,
  );
  expectFailure('minimum node count', { ...base, nodes: base.nodes.slice(0, 2) }, /too few nodes/);
  expectFailure(
    'seeded control presence',
    {
      ...base,
      nodes: [
        ...base.nodes.filter((node) => node.identifier !== 'field-email'),
        { index: 3, ref: 'e4', type: 'Other' },
      ],
    },
    /missing field-email/,
  );
  expectFailure(
    'label identity',
    { ...base, nodes: updateControl('field-name', { label: 'Name' }) },
    /label drift/,
  );
  expectFailure(
    'canonical role identity',
    { ...base, nodes: updateControl('field-name', { type: 'StaticText' }) },
    /role drift/,
  );
  expectFailure(
    'enabled interactivity',
    { ...base, nodes: updateControl('field-name', { enabled: false }) },
    /did not mark field-name enabled/,
  );
  expectFailure(
    'semantic interactivity',
    { ...base, nodes: updateControl('field-name', { type: 'StaticText', role: 'text-field' }) },
    /did not expose field-name as a semantic control/,
  );
  expectFailure(
    'positive interaction geometry',
    { ...base, nodes: updateControl('field-name', { rect: { x: 0, y: 0, width: 0, height: 20 } }) },
    /did not expose positive interaction geometry/,
  );
  expectFailure(
    'structured hittable evidence',
    { ...base, nodes: updateControl('field-name', { hittable: undefined }) },
    /omitted its structured hittable result/,
  );
  expectFailure(
    'geometric actionability',
    { ...base, nodes: updateControl('field-name', { hittable: false }) },
    /did not expose field-name as geometrically actionable/,
  );
  expectFailure(
    'seeded field value',
    { ...base, nodes: updateControl('field-email', { value: 'wrong@example.test' }) },
    /value drift/,
  );
});

test('backend forcing stays in the test-owned daemon transport seam', async () => {
  type Request = Parameters<import('@agent-device/contracts/client').AgentDeviceDaemonTransport>[0];
  let received: Request | undefined;
  const transport = createSnapshotBackendConformanceTransport('tree', async (request) => {
    received = request;
    return { ok: true, data: {} };
  });

  await transport({ command: 'snapshot', positionals: [], session: 'default', flags: {} });

  assert.equal(received?.flags?.snapshotPreferredBackend, 'tree');
  assert.equal(
    (received?.flags as Record<string, unknown> | undefined)?.preferredBackend,
    undefined,
  );
});
