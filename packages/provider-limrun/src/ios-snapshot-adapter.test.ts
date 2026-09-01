import { expect, test, vi } from 'vitest';
import {
  IOS_SNAPSHOT_PRODUCER_CAPABILITIES,
  createIosSnapshotRequest,
  planIosSnapshot,
} from '@agent-device/capture-kit/ios-snapshot-planning';
import { captureLimrunIosSnapshot } from './ios-snapshot-adapter.ts';
import {
  LIMRUN_SNAPSHOT_SCREEN,
  createLimrunSnapshotSession,
  limrunSnapshotTree,
} from './ios-snapshot-adapter.fixtures.ts';

test('uses Limrun deviceInfo as the reported engine viewport without passing presentation options to elementTree', async () => {
  const session = createLimrunSnapshotSession();
  const elementTree = vi.fn(session.client.elementTree);
  const result = await captureLimrunIosSnapshot(
    { ...session, client: { ...session.client, elementTree } },
    { scope: 'Target', depth: 1, interactiveOnly: true },
  );

  expect(elementTree).toHaveBeenCalledWith();
  expect(result.nodes?.map((node) => node.label)).toEqual(['Target', 'Save', 'Save']);
  expect(result.nodes?.find((node) => node.label === 'Save')?.hittable).toBe(false);
  expect(result.warnings).toContain(
    'Limrun iOS snapshots do not provide hittability evidence; regular snapshots will not mark nodes actionable.',
  );
});

test.each([
  {
    name: 'raw full',
    options: { raw: true, interactiveOnly: true },
    labels: ['App', 'Settings', 'Target', 'Save', 'Save'],
  },
  { name: 'raw traversal depth', options: { raw: true, depth: 1 }, labels: ['App', 'Settings'] },
  { name: 'regular presented depth', options: { depth: 1 }, labels: ['App', 'Settings'] },
  { name: 'regular scope', options: { scope: 'Target' }, labels: ['Target', 'Save', 'Save'] },
])('routes $name through the shared engine projection', async ({ options, labels }) => {
  const result = await captureLimrunIosSnapshot(createLimrunSnapshotSession(), options);

  expect(result.nodes?.map((node) => node.label)).toEqual(labels);
  expect(result.truncated).toBe(false);
});

test('the Limrun capability plan narrows only the raw traversal tier and records unavailable facts', () => {
  const request = createIosSnapshotRequest({ raw: true, interactiveOnly: true, depth: 2 });
  const plan = planIosSnapshot(request, IOS_SNAPSHOT_PRODUCER_CAPABILITIES['limrun-ios-tree']);

  expect(plan.narrowing).toEqual({ depth: 2, scope: null, interactiveOnly: false });
  expect(plan.evidence).toEqual({
    scope: 'incomplete',
    interactiveQuery: 'incomplete',
    viewport: 'available',
    hittability: 'unavailable',
  });
});

test('regular Limrun presentation never infers hittability from an enabled rectangle', async () => {
  const tree = limrunSnapshotTree();
  tree.children![0]!.children!.push({
    elementType: 'Button',
    label: 'Enabled but unverified',
    frame: { x: 120, y: 120, width: 80, height: 40 },
    enabled: true,
    hittable: true,
  });

  const result = await captureLimrunIosSnapshot(createLimrunSnapshotSession(tree));
  const target = result.nodes?.find((node) => node.label === 'Enabled but unverified');

  expect(target).toMatchObject({ enabled: true, rect: { x: 120, y: 120, width: 80, height: 40 } });
  expect(target?.hittable).toBe(false);
});

test('regular presentation fails with a typed viewport error while raw output discloses the missing evidence', async () => {
  const session = createLimrunSnapshotSession(limrunSnapshotTree(), { width: 0, height: 240 });

  await expect(captureLimrunIosSnapshot(session)).rejects.toMatchObject({
    code: 'COMMAND_FAILED',
    details: { reason: 'invalid-viewport' },
  });

  const raw = await captureLimrunIosSnapshot(session, { raw: true });
  expect(raw.nodes).toHaveLength(5);
  expect(raw.warnings).toContain(
    'Limrun iOS snapshots did not provide a valid viewport (invalid); raw output is available, but regular presentation requires viewport evidence.',
  );
});

test('the Limrun acquired result keeps provider provenance and SDK screen dimensions', async () => {
  const result = await captureLimrunIosSnapshot(createLimrunSnapshotSession());

  expect(result).toMatchObject({
    backend: 'xctest',
    producer: 'limrun-ios-tree',
  });
  expect(result.nodes?.[0]?.rect).toEqual({
    x: 0,
    y: 0,
    width: LIMRUN_SNAPSHOT_SCREEN.width,
    height: LIMRUN_SNAPSHOT_SCREEN.height,
  });
});
