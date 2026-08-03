import { beforeEach, expect, test, vi } from 'vitest';
import { attachRefs } from '@agent-device/kernel/snapshot';
import { makeIosSession } from '../../../__tests__/test-utils/session-factories.ts';
import { makeSessionStore } from '../../../__tests__/test-utils/store-factory.ts';
import { activateCompleteRefFrame, refFrameState } from '../../ref-frame.ts';

vi.mock('../../../core/dispatch.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../core/dispatch.ts')>();
  return {
    ...actual,
    dispatchGestureViewport: vi.fn(async () => ({ x: 0, y: 0, width: 400, height: 800 })),
    dispatchGesturePlan: vi.fn(async () => ({})),
  };
});

vi.mock('../interaction-snapshot.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../interaction-snapshot.ts')>();
  return {
    ...actual,
    captureSnapshotForSession: vi.fn(
      async (session: import('../../types.ts').SessionState) => session.snapshot!,
    ),
  };
});

import { dispatchGesturePlan } from '../../../core/dispatch.ts';
import { handleInteractionCommands } from '../interaction.ts';

const mockDispatchGesturePlan = vi.mocked(dispatchGesturePlan);
const contextFromFlags = () => ({});

beforeEach(() => {
  mockDispatchGesturePlan.mockClear();
  mockDispatchGesturePlan.mockResolvedValue({});
});

function makeDragSession(sessionName: string) {
  const session = makeIosSession(sessionName, {
    appBundleId: 'com.example.drag-fixture',
    recordSession: true,
  });
  session.snapshot = {
    nodes: attachRefs([
      {
        index: 0,
        type: 'Application',
        rect: { x: 0, y: 0, width: 400, height: 800 },
      },
      {
        index: 1,
        parentIndex: 0,
        type: 'View',
        identifier: 'drag-source',
        label: 'Drag source',
        rect: { x: 20, y: 100, width: 120, height: 60 },
        hittable: true,
      },
      {
        index: 2,
        parentIndex: 0,
        type: 'View',
        identifier: 'drop-target',
        label: 'Drop target',
        rect: { x: 220, y: 400, width: 140, height: 80 },
        hittable: true,
      },
    ]),
    createdAt: Date.now(),
    backend: 'xctest',
  };
  session.snapshotGeneration = 42;
  activateCompleteRefFrame(session);
  return session;
}

async function runDrag(sessionStore: ReturnType<typeof makeSessionStore>, sessionName: string) {
  return await handleInteractionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'gesture',
      positionals: [],
      flags: {},
      input: {
        kind: 'drag',
        source: '@e2~s42',
        destination: '@e3~s42',
        sourceHoldMs: 700,
        moveMs: 600,
        destinationHoldMs: 200,
      },
    },
    sessionName,
    sessionStore,
    contextFromFlags,
  });
}

test('recorded ref drag dispatches once and stores portable selectors with both endpoint identities', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'recorded-drag';
  const session = makeDragSession(sessionName);
  sessionStore.set(sessionName, session);

  const response = await runDrag(sessionStore, sessionName);

  expect(response?.ok).toBe(true);
  if (response?.ok) {
    expect(response.data).toMatchObject({
      kind: 'drag',
      durationMs: 1_500,
      from: { x: 80, y: 130 },
      to: { x: 290, y: 440 },
      targets: {
        source: {
          selectorChain: expect.arrayContaining(['id="drag-source"']),
          resolution: { source: 'ref', phase: 'pre-action', kind: 'exact' },
        },
        destination: {
          selectorChain: expect.arrayContaining(['id="drop-target"']),
          resolution: { source: 'ref', phase: 'pre-action', kind: 'exact' },
        },
      },
    });
    expect(response.data).not.toHaveProperty('recording');
    expect(response.data).not.toHaveProperty('selectorChain');
    expect(response.data).not.toHaveProperty('targetEvidence');
  }
  expect(mockDispatchGesturePlan).toHaveBeenCalledTimes(1);
  expect(refFrameState(session)).toBe('expired');

  const recorded = session.actions[0];
  expect(recorded?.positionals?.[0]).toBe('drag');
  expect(recorded?.positionals?.[1]?.split(' || ')[0]).toBe('id="drag-source"');
  expect(recorded?.positionals?.[2]?.split(' || ')[0]).toBe('id="drop-target"');
  expect(recorded?.positionals?.slice(3)).toEqual(['700', '600', '200']);
  expect(recorded?.result).toMatchObject({
    selectorChain: expect.arrayContaining(['id="drag-source"']),
  });
  expect(recorded?.targetEvidence).toBeUndefined();
  expect(recorded?.targetEvidences).toMatchObject({
    source: { id: 'drag-source', label: 'Drag source', verification: 'verified' },
    destination: { id: 'drop-target', label: 'Drop target', verification: 'verified' },
  });
});

test('a second ref drag is rejected before dispatch after the first drag expires the frame', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'stale-drag';
  sessionStore.set(sessionName, makeDragSession(sessionName));

  expect((await runDrag(sessionStore, sessionName))?.ok).toBe(true);
  const response = await runDrag(sessionStore, sessionName);

  expect(response?.ok).toBe(false);
  if (response && !response.ok) {
    expect(response.error.details).toMatchObject({
      reason: 'ref_frame_expired',
      ref: '@e2',
      currentGeneration: 42,
    });
  }
  expect(mockDispatchGesturePlan).toHaveBeenCalledTimes(1);
});
