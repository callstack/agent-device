import { attachSnapshotTextInputGeometry } from '@agent-device/contracts/capture';
import { beforeEach, expect, test } from 'vitest';
import { attachRefs } from '@agent-device/kernel/snapshot';
import { makeSessionStore } from '../../../__tests__/support/store-factory.ts';
import { runInteraction } from '../../../__tests__/support/touch-interaction-runner.ts';
import {
  activateCompleteRefFrame,
  markSessionSnapshotOutdated,
  refFrameState,
} from '../../../core/ref-frame.ts';
import { setSessionSnapshot } from '../../session-snapshot.ts';
import {
  installInteractorSnapshotResolution,
  mockInteractorSnapshot,
} from '../../../__tests__/support/interactor-resolution-fixture.ts';
import {
  elementReadFixtureState,
  mockQuerySelector,
  mockTapPoint,
  resetGetRuntimeFixture,
} from '../../__tests__/interaction-get-runtime-fixture.ts';
import { makeSession } from './__tests__/interaction-touch-fixtures.ts';

beforeEach(() => {
  resetGetRuntimeFixture();
  installInteractorSnapshotResolution();
  mockInteractorSnapshot.mockReset();
});

function setup() {
  const store = makeSessionStore();
  const session = makeSession('tap-text-input');
  session.snapshot = {
    nodes: attachRefs([
      { index: 0, type: 'Application', rect: { x: 0, y: 0, width: 390, height: 844 } },
      {
        index: 1,
        parentIndex: 0,
        type: 'Button',
        label: 'Home',
        rect: { x: 10, y: 740, width: 60, height: 40 },
        hittable: true,
      },
      {
        index: 2,
        parentIndex: 0,
        type: 'TextField',
        label: 'Search',
        rect: { x: 10, y: 100, width: 300, height: 40 },
        hittable: true,
      },
    ]),
    createdAt: 1,
    backend: 'xctest',
    producer: 'apple-runner',
  };
  attachSnapshotTextInputGeometry(session.snapshot.nodes, {
    rects: [{ x: 10, y: 100, width: 300, height: 40 }],
  });
  activateCompleteRefFrame(session);
  store.publish(session.name, session);
  return { store, session };
}

test('the active ref frame supplies input geometry before the side-effect seam expires it', async () => {
  const { store, session } = setup();
  const result = await runInteraction(store, session.name, 'click', ['@e2']);
  expect(result?.ok).toBe(true);
  expect(mockTapPoint).toHaveBeenCalledWith(
    expect.objectContaining({
      point: { x: 40, y: 760 },
      options: expect.objectContaining({
        coordinateTapTextInputEvidence: {
          targetBundleId: session.appBundleId,
          point: { x: 40, y: 760 },
          textInputRects: [{ x: 10, y: 100, width: 300, height: 40 }],
        },
      }),
    }),
  );
  expect(refFrameState(store.get(session.name)!)).toBe('expired');
  expect((await runInteraction(store, session.name, 'click', ['@e2']))?.ok).toBe(false);
  expect(mockTapPoint).toHaveBeenCalledTimes(1);
});

test('a selector uses this request capture rather than the stored input geometry', async () => {
  const { store, session } = setup();
  const nodes = session.snapshot!.nodes.map((node) =>
    node.type === 'TextField'
      ? { ...node, rect: { x: 200, y: 160, width: 100, height: 40 } }
      : node,
  );
  attachSnapshotTextInputGeometry(nodes, { rects: [{ x: 200, y: 160, width: 100, height: 40 }] });
  mockInteractorSnapshot.mockResolvedValue({ nodes, backend: 'xctest', producer: 'apple-runner' });
  const result = await runInteraction(store, session.name, 'click', ['role=button label=Home']);
  expect(result?.ok).toBe(true);
  expect(mockTapPoint.mock.calls[0]?.[0].options.coordinateTapTextInputEvidence).toEqual({
    targetBundleId: session.appBundleId,
    point: { x: 40, y: 760 },
    textInputRects: [{ x: 200, y: 160, width: 100, height: 40 }],
  });
});

test('a rescued selector point keeps probing although the capture placed an input off-screen', async () => {
  const { store, session } = setup();
  const capturedRect = { x: 10, y: 900, width: 300, height: 40 };
  const nodes = attachRefs([
    { index: 0, type: 'Application', rect: { x: 0, y: 0, width: 390, height: 844 } },
    {
      index: 1,
      parentIndex: 0,
      type: 'TextField',
      label: 'Email',
      identifier: 'email',
      rect: capturedRect,
      hittable: true,
    },
  ]);
  attachSnapshotTextInputGeometry(nodes, { rects: [capturedRect] });
  mockInteractorSnapshot.mockResolvedValue({ nodes, backend: 'xctest', producer: 'apple-runner' });
  elementReadFixtureState.querySelectorAvailable = true;
  mockQuerySelector.mockResolvedValue({
    found: true,
    node: { rect: { x: 10, y: 300, width: 300, height: 40 }, hittable: true },
  });
  expect((await runInteraction(store, session.name, 'click', ['id=email']))?.ok).toBe(true);
  expect(mockTapPoint.mock.calls[0]?.[0].point).toEqual({ x: 160, y: 320 });
  expect(mockTapPoint.mock.calls[0]?.[0].options.coordinateTapTextInputEvidence).toBeUndefined();
});

test('a newer read-only observation keeps probing when the ref frame predates an input at the tap point', async () => {
  const { store, session } = setup();
  // The newer observation names a different element at @e2, so the tap keeps the frame's node.
  const nodes = session.snapshot!.nodes.map((node) => {
    if (node.type === 'TextField')
      return { ...node, rect: { x: 10, y: 740, width: 100, height: 40 } };
    return node.label === 'Home' ? { ...node, label: 'Profile' } : node;
  });
  attachSnapshotTextInputGeometry(nodes, { rects: [{ x: 10, y: 740, width: 100, height: 40 }] });
  setSessionSnapshot(session, { ...session.snapshot!, nodes, createdAt: 2 });
  expect(refFrameState(session)).toBe('active');
  expect((await runInteraction(store, session.name, 'click', ['@e2']))?.ok).toBe(true);
  expect(mockTapPoint.mock.calls[0]?.[0].options.coordinateTapTextInputEvidence).toBeUndefined();
});

test('an outdated observation keeps probing even when it still owns the active refs', async () => {
  const { store, session } = setup();
  markSessionSnapshotOutdated(session);
  expect(refFrameState(session)).toBe('active');
  expect((await runInteraction(store, session.name, 'click', ['@e2']))?.ok).toBe(true);
  expect(mockTapPoint.mock.calls[0]?.[0].options.coordinateTapTextInputEvidence).toBeUndefined();
});

test('raw coordinates do not borrow a stored tree even when its ref frame is active', async () => {
  const { store, session } = setup();
  expect((await runInteraction(store, session.name, 'click', ['40', '760']))?.ok).toBe(true);
  expect(mockTapPoint.mock.calls[0]?.[0].options.coordinateTapTextInputEvidence).toBeUndefined();
});

test('a projected tree without acquisition geometry keeps probing', async () => {
  const { store, session } = setup();
  session.snapshot!.nodes = [...session.snapshot!.nodes];
  activateCompleteRefFrame(session);
  expect((await runInteraction(store, session.name, 'click', ['@e2']))?.ok).toBe(true);
  expect(mockTapPoint.mock.calls[0]?.[0].options.coordinateTapTextInputEvidence).toBeUndefined();
});
