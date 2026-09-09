import { test, expect, vi, beforeEach } from 'vitest';
import type { SessionState } from '../../../session-state.ts';
import { buildSnapshotSignatures } from '@agent-device/capture-kit/snapshot-freshness';
import { makeSessionStore } from '../../../../__tests__/test-utils/store-factory.ts';
import {
  makeAuthoringSession,
  makeIosSession as makeSession,
} from '../../../../__tests__/test-utils/session-factories.ts';

vi.mock('@agent-device/device-selection/dispatch-resolve', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    resolveTargetDevice: actual.resolveTargetDevice,
  };
});
vi.mock('../../../snapshot-interactor-capture.ts', async () => {
  const fixture = await import('../../../__tests__/legacy-snapshot-capture-fixture.ts');
  return { captureSnapshotWithInteractor: fixture.captureSnapshotThroughLegacyDispatchFixture };
});

import {
  mockDispatch,
  resetFindTouchRuntimeFixture,
  runFindClickScenario,
} from './find-touch-runtime-fixture.ts';
import { invokeFindHandler } from './find-handler-fixture.ts';

beforeEach(() => {
  resetFindTouchRuntimeFixture();
});

test('handleFindCommands wait bypasses snapshot cache while Android freshness recovery is active', async () => {
  const sessionName = 'android-find-wait';
  const session: SessionState = {
    name: sessionName,
    device: {
      platform: 'android',
      id: 'emulator-5554',
      name: 'Pixel 9 Pro XL',
      kind: 'emulator',
      target: 'mobile',
      booted: true,
    },
    createdAt: Date.now(),
    actions: [],
  };
  const baselineNodes = Array.from({ length: 16 }, (_, index) => ({
    ref: `e${index + 1}`,
    index,
    depth: 0,
    type: 'android.widget.TextView',
    label: `Inbox row ${index + 1}`,
  }));
  session.snapshot = {
    nodes: baselineNodes,
    createdAt: Date.now(),
    backend: 'android',
    comparisonSafe: true,
  };
  session.androidSnapshotFreshness = {
    action: 'press',
    markedAt: Date.now(),
    baselineCount: baselineNodes.length,
    baselineSignatures: buildSnapshotSignatures(baselineNodes),
    routeComparable: true,
  };

  mockDispatch
    .mockResolvedValueOnce({
      nodes: Array.from({ length: 16 }, (_, index) => ({
        index,
        depth: 0,
        type: 'android.widget.TextView',
        label: `Inbox row ${index + 1}`,
      })),
      truncated: false,
      backend: 'android',
      analysis: { rawNodeCount: 16, maxDepth: 1 },
    })
    .mockResolvedValueOnce({
      nodes: [
        { index: 0, depth: 0, type: 'android.widget.TextView', label: 'Create document' },
        { index: 1, depth: 0, type: 'android.widget.Button', label: 'Submit', hittable: true },
      ],
      truncated: false,
      backend: 'android',
      analysis: { rawNodeCount: 2, maxDepth: 1 },
    });

  const { response } = await runFindClickScenario({
    positionals: ['text', 'Create document', 'wait', '700'],
    session,
  });

  expect(response.ok).toBe(true);
  if (response.ok) {
    expect(response.data?.found).toBe(true);
  }
  expect(mockDispatch).toHaveBeenCalledTimes(2);
});

test('handleFindCommands wait reports sparse verdict through selector runtime route', async () => {
  const session = makeSession('default');
  session.snapshot = {
    nodes: [
      {
        index: 0,
        ref: 'e1',
        type: 'Button',
        label: 'Previous screen action',
        rect: { x: 24, y: 600, width: 180, height: 52 },
      },
    ],
    createdAt: Date.now(),
    backend: 'xctest',
  };
  const previousSnapshot = session.snapshot;
  mockDispatch.mockImplementation(async (_device, command) => {
    if (command !== 'snapshot') return {};
    return {
      backend: 'xctest',
      quality: {
        state: 'sparse',
        backend: 'private-ax',
        reason: 'sparse tree',
        reasonCode: 'sparse-tree',
      },
      nodes: [
        {
          index: 0,
          type: 'Application',
        },
      ],
    };
  });

  const { response } = await runFindClickScenario({
    positionals: ['text', 'Never appears', 'wait', '350'],
    session,
  });

  expect(response.ok).toBe(false);
  expect(session.snapshot).toBe(previousSnapshot);
  expect(!response.ok && response.error).toMatchObject({
    code: 'COMMAND_FAILED',
    message: 'find could not read the current accessibility tree',
    details: {
      reason: 'sparse tree',
      hint: expect.stringContaining('snapshot quality verdict is sparse'),
    },
  });
});

test('handleFindCommands wait captures fresh snapshots while polling', async () => {
  const { response } = await runFindClickScenario({
    positionals: ['text', 'Never appears', 'wait', '350'],
    nodes: [{ index: 0, depth: 0, type: 'StaticText', label: 'Other text' }],
  });

  expect(response.ok).toBe(false);
  if (!response.ok) {
    expect(response.error.message).toContain('find wait timed out');
  }
  // What this test guards is that every poll re-captures instead of reusing the first tree.
  // The exact poll count is a timing artifact and is not assertable: the loop's last sleep
  // consumes whatever remains of the budget, so it lands on `remainingMs() === 0`, and a
  // sleep that returns a millisecond early admits one more poll. Pinning this to 2 made the
  // test fail under CI load on unrelated PRs. Assert the property, not the artifact.
  expect(mockDispatch.mock.calls.length).toBeGreaterThanOrEqual(2);
  expect(mockDispatch.mock.calls.every(([, command]) => command === 'snapshot')).toBe(true);
});

test('read-only find while recording is intentionally deferred from target-v1 evidence (#1349)', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'default';
  const session = makeAuthoringSession(sessionName);
  sessionStore.set(sessionName, session);
  mockDispatch.mockImplementation(async (_device, command) => {
    if (command === 'snapshot') {
      return {
        nodes: [
          {
            index: 0,
            depth: 0,
            type: 'Button',
            label: 'Save',
            rect: { x: 10, y: 10, width: 40, height: 20 },
            enabled: true,
            hittable: true,
          },
        ],
      };
    }
    return {};
  });

  const response = await invokeFindHandler({
    sessionName,
    sessionStore,
    positionals: ['text', 'Save', 'exists'],
    invoke: async () => ({ ok: true, data: {} }),
  });

  expect(response?.ok).toBe(true);
  const recordedAction = sessionStore.get(sessionName)?.actions[0];
  expect(recordedAction?.command).toBe('find');
  // The fuzzy-locator resolution has no selector-chain identity token for
  // replay verification, so read-only find records NO annotation in v1 —
  // an explicit deferral, not an accident.
  expect(recordedAction?.targetEvidence).toBeUndefined();
});
