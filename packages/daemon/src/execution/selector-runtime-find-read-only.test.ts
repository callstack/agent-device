import { test, expect, beforeEach } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import { isSparseSnapshotQualityVerdict } from '@agent-device/capture-kit/snapshot-quality-verdict';
import { buildSnapshotSignatures } from '@agent-device/capture-kit/snapshot-freshness';
import type { DaemonFindOptions } from '@agent-device/contracts/daemon-command-surface';
import type { AgentDeviceRuntimeConfig } from '@agent-device/contracts/runtime-contract';
import type { SessionState } from '../core/session-state.ts';
import { makeSessionStore } from '../__tests__/support/store-factory.ts';
import {
  makeAuthoringSession,
  makeIosSession as makeSession,
} from '../__tests__/support/session-factories.ts';
import { commandSurfaceWithMembers } from '../__tests__/support/command-surface-override-fake.ts';
import { installLegacyCaptureInteractorResolution } from '../__tests__/support/legacy-capture-interactor-resolution.ts';
import {
  mockDispatch,
  resetFindTouchRuntimeFixture,
  runFindClickScenario,
} from './interaction/internal/__tests__/find-touch-runtime-fixture.ts';
import { invokeFindHandler } from './interaction/internal/__tests__/find-handler-fixture.ts';

installLegacyCaptureInteractorResolution();

beforeEach(() => {
  resetFindTouchRuntimeFixture();
});

/**
 * `find <text> wait|exists` as the command family serves it: capture through the config's backend
 * up to `maxPolls` times, answer found once a node carries the query as its label, and fail with
 * the timeout the command family reports otherwise. Everything the daemon decides about those
 * captures (cache tier, freshness recovery, what a sparse tree may store) happens behind the
 * backend, which is what these cases pin.
 */
function pollingFindSurface(maxPolls: number) {
  return commandSurfaceWithMembers((config: AgentDeviceRuntimeConfig) => ({
    selectors: {
      find: async (options: DaemonFindOptions) => {
        for (let poll = 0; poll < maxPolls; poll += 1) {
          const captured = await config.backend.captureSnapshot?.(
            { session: options.session, requestId: options.requestId, signal: options.signal },
            { interactiveOnly: true },
          );
          if (!captured?.snapshot) throw new Error('the backend returned no snapshot');
          if (isSparseSnapshotQualityVerdict(captured.snapshot.snapshotQuality)) {
            throw new AppError(
              'COMMAND_FAILED',
              'find could not read the current accessibility tree',
              { reason: captured.snapshot.snapshotQuality?.reason },
            );
          }
          if (captured.snapshot.nodes.some((node) => node.label === options.query)) {
            return { kind: 'found' as const, found: true as const };
          }
        }
        throw new AppError('COMMAND_FAILED', 'find wait timed out');
      },
    },
  }));
}

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
    createCommandSurface: pollingFindSurface(1),
    positionals: ['text', 'Create document', 'wait', '700'],
    session,
  });

  expect(response.ok).toBe(true);
  if (response.ok) {
    expect(response.data?.found).toBe(true);
  }
  expect(mockDispatch).toHaveBeenCalledTimes(2);
});

test('handleFindCommands wait over a sparse capture hands the surface its sparse verdict and leaves the stored tree alone', async () => {
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
    createCommandSurface: pollingFindSurface(1),
    positionals: ['text', 'Never appears', 'wait', '350'],
    session,
  });

  expect(response.ok).toBe(false);
  expect(session.snapshot).toBe(previousSnapshot);
  // The sparse verdict is the daemon's capture result reaching the surface: a timeout would carry no
  // reason, so the reason proves the refusal came from the verdict and not from the poll budget.
  expect(!response.ok && response.error).toMatchObject({
    code: 'COMMAND_FAILED',
    details: { reason: 'sparse tree' },
  });
});

test('handleFindCommands wait captures fresh snapshots while polling', async () => {
  const polls = 3;
  const { response } = await runFindClickScenario({
    createCommandSurface: pollingFindSurface(polls),
    positionals: ['text', 'Never appears', 'wait', '350'],
    nodes: [{ index: 0, depth: 0, type: 'StaticText', label: 'Other text' }],
  });

  expect(response.ok).toBe(false);
  if (!response.ok) {
    expect(response.error.message).toContain('find wait timed out');
  }
  // Every poll the surface takes reaches the device: the daemon forces a fresh capture for `find`
  // instead of answering the later polls from the first tree inside the cache window. The poll
  // count is the surface's here, so the property holds without waiting on a real clock.
  expect(mockDispatch.mock.calls.length).toBe(polls);
  expect(mockDispatch.mock.calls.every(([, command]) => command === 'snapshot')).toBe(true);
});

test('read-only find while recording is intentionally deferred from target-v1 evidence (#1349)', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'default';
  const session = makeAuthoringSession(sessionName);
  sessionStore.publish(sessionName, session);
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
    createCommandSurface: pollingFindSurface(1),
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
