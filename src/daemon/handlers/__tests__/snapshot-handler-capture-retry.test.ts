import { test, expect, vi, afterEach, beforeEach } from 'vitest';
import { legacyDispatchCapture } from '../../__tests__/legacy-snapshot-capture-fixture.ts';
import {
  getRuntimeBindings,
  mockTapPoint,
  resetGetRuntimeFixture,
} from '../../__tests__/interaction-get-runtime-fixture.ts';
import { captureSnapshot } from '../../snapshot-capture.ts';
import { setActiveProviderDeviceRuntimes } from '../../../provider-device-runtime.ts';
import { buildInteractionSurfaceSignature } from '../../interaction-outcome-policy.ts';
import { buildNodes } from '../../../__tests__/test-utils/snapshot-builders.ts';
import { resetSnapshotRuntimeFixture } from '../../__tests__/snapshot-runtime-fixture.ts';
import {
  androidCapture,
  androidDevice,
  androidTextRows,
  inboxBaselineNodes,
  iosSimulatorDevice,
  makeAndroidFreshnessSession,
  makeSession,
} from './snapshot-handler.fixtures.ts';

vi.mock('../../snapshot-interactor-capture.ts', async () => {
  const fixture = await import('../../__tests__/legacy-snapshot-capture-fixture.ts');
  return { captureSnapshotWithInteractor: fixture.captureSnapshotThroughLegacyDispatchFixture };
});
vi.mock('@agent-device/platform-apple/runner/operations', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@agent-device/platform-apple/runner/operations')>();
  return { ...actual, runAppleRunnerCommand: vi.fn(async () => ({})) };
});

// The real implementation shells out to simctl to probe for a hint-worthy
// unambiguous environment; that live-probe logic is covered by
// ios-app-session-hint.test.ts. Stubbed here so this suite stays hermetic and
// fast — defaults to "no enrichment", matching the current-behavior fallback.
vi.mock('../../ios-app-session-hint.ts', () => ({
  buildIosOpenCommandHint: vi.fn(async () => undefined),
}));

import { runAppleRunnerCommand } from '@agent-device/platform-apple/runner/operations';
import { buildIosOpenCommandHint } from '../../ios-app-session-hint.ts';

const mockRunnerCommand = vi.mocked(runAppleRunnerCommand);
const mockBuildIosOpenCommandHint = vi.mocked(buildIosOpenCommandHint);

afterEach(() => {
  setActiveProviderDeviceRuntimes([]);
});

beforeEach(() => {
  resetSnapshotRuntimeFixture();
  legacyDispatchCapture.mockReset();
  legacyDispatchCapture.mockResolvedValue({});
  resetGetRuntimeFixture();
  mockRunnerCommand.mockReset();
  mockRunnerCommand.mockResolvedValue({});
  mockBuildIosOpenCommandHint.mockReset();
  mockBuildIosOpenCommandHint.mockResolvedValue(undefined);
});

test('captureSnapshot lazily retries pending no-change touch before returning fresh state', async () => {
  const sessionName = 'ios-lazy-outcome-retry';
  const session = makeSession(sessionName, iosSimulatorDevice);
  const baselineNodes = [
    {
      ref: 'e1',
      index: 0,
      depth: 0,
      type: 'Button',
      label: 'Open feed',
      identifier: 'open-feed',
      hittable: true,
      rect: { x: 20, y: 120, width: 160, height: 48 },
    },
  ];
  session.snapshot = {
    nodes: baselineNodes,
    createdAt: Date.now(),
    backend: 'xctest',
  };
  session.pendingInteractionOutcome = {
    action: 'click',
    command: 'press',
    positionals: ['100', '144'],
    flags: { platform: 'ios' },
    markedAt: Date.now(),
    attemptsRemaining: 2,
    preSignature: [
      {
        key: 'open-feed|Open feed||Button||enabled|unselected|hittable|#0',
        x: 20,
        y: 120,
        width: 160,
        height: 48,
        discriminating: true,
      },
    ],
  };

  let pressed = false;
  mockTapPoint.mockImplementation(async () => {
    pressed = true;
    return { clicked: true };
  });
  legacyDispatchCapture.mockImplementation(async () => {
    return {
      nodes: !pressed
        ? baselineNodes
        : [
            {
              index: 0,
              depth: 0,
              type: 'Button',
              label: 'Back',
              identifier: 'back',
              hittable: true,
              rect: { x: 20, y: 60, width: 90, height: 44 },
            },
            {
              index: 1,
              depth: 0,
              type: 'StaticText',
              label: 'Feed',
              rect: { x: 20, y: 140, width: 160, height: 48 },
            },
          ],
      backend: 'xctest',
    };
  });

  const result = await captureSnapshot({
    device: iosSimulatorDevice,
    session,
    flags: { snapshotInteractiveOnly: true },
    logPath: '/tmp/daemon.log',
    ...getRuntimeBindings(),
  });

  expect(result.snapshot.nodes).toEqual(
    expect.arrayContaining([expect.objectContaining({ label: 'Feed' })]),
  );
  // R58: the retry re-fires through the bound `tapPoint`, on the recorded coordinate pair.
  expect(mockTapPoint).toHaveBeenCalledTimes(1);
  expect(mockTapPoint.mock.calls[0]?.[0]?.point).toEqual({ x: 100, y: 144 });
  expect(session.pendingInteractionOutcome).toBeUndefined();
});

test('captureSnapshot does not retry when a tap change appears after a short delay', async () => {
  const sessionName = 'android-delayed-outcome-without-retry';
  const session = makeSession(sessionName, androidDevice);
  const baselineNodes = [
    {
      ref: 'e1',
      index: 0,
      depth: 0,
      type: 'android.widget.Button',
      label: 'Open drawer',
      hittable: true,
      rect: { x: 20, y: 120, width: 160, height: 48 },
    },
  ];
  const changedNodes = [
    {
      index: 0,
      depth: 0,
      type: 'android.widget.TextView',
      label: 'Albums',
      rect: { x: 32, y: 240, width: 180, height: 52 },
    },
  ];
  session.pendingInteractionOutcome = {
    action: 'click',
    command: 'press',
    positionals: ['100', '144'],
    flags: { platform: 'android' },
    markedAt: Date.now(),
    attemptsRemaining: 2,
    preSignature: buildInteractionSurfaceSignature(baselineNodes),
  };

  let snapshotCalls = 0;
  legacyDispatchCapture.mockImplementation(async (_device, command) => {
    expect(command).toBe('snapshot');
    snapshotCalls += 1;
    return {
      nodes: snapshotCalls === 1 ? baselineNodes : changedNodes,
      backend: 'android',
    };
  });

  const result = await captureSnapshot({
    device: androidDevice,
    session,
    flags: { snapshotInteractiveOnly: true },
    logPath: '/tmp/daemon.log',
  });

  expect(result.snapshot.nodes).toEqual(
    expect.arrayContaining([expect.objectContaining({ label: 'Albums' })]),
  );
  expect(legacyDispatchCapture.mock.calls.map((call) => call[1])).toEqual(['snapshot', 'snapshot']);
  expect(session.pendingInteractionOutcome).toBeUndefined();
});

test('captureSnapshot retries pending tap outcome before post-gesture stabilization', async () => {
  const sessionName = 'android-maestro-tap-outcome-before-stabilization';
  const session = makeSession(sessionName, androidDevice);
  const baselineNodes = [
    {
      ref: 'e1',
      index: 0,
      depth: 0,
      type: 'android.widget.Button',
      label: 'Navigate to Third',
      hittable: true,
      rect: { x: 302, y: 1301, width: 476, height: 110 },
    },
  ];
  session.snapshot = {
    nodes: baselineNodes,
    createdAt: Date.now(),
    backend: 'android',
  };
  session.pendingInteractionOutcome = {
    action: 'click',
    command: 'press',
    positionals: ['540', '1356'],
    flags: { platform: 'android' },
    markedAt: Date.now(),
    attemptsRemaining: 2,
    preSignature: [
      {
        key: '|Navigate to Third||android.widget.Button||enabled|unselected|hittable|#0',
        x: 302,
        y: 1301,
        width: 476,
        height: 110,
        discriminating: true,
      },
    ],
  };
  session.postGestureStabilization = {
    action: 'click',
    positionals: [],
    markedAt: Date.now(),
  };

  let pressed = false;
  mockTapPoint.mockImplementation(async () => {
    pressed = true;
    return { clicked: true };
  });
  legacyDispatchCapture.mockImplementation(async () => {
    return {
      nodes: !pressed
        ? baselineNodes
        : [
            {
              index: 0,
              depth: 0,
              type: 'android.widget.TextView',
              label: 'Tab Third (3)',
              rect: { x: 390, y: 884, width: 300, height: 55 },
            },
          ],
      backend: 'android',
    };
  });

  const result = await captureSnapshot({
    device: androidDevice,
    session,
    flags: { snapshotInteractiveOnly: true },
    logPath: '/tmp/daemon.log',
    ...getRuntimeBindings(),
  });

  expect(result.snapshot.nodes).toEqual(
    expect.arrayContaining([expect.objectContaining({ label: 'Tab Third (3)' })]),
  );
  // R58: the retry re-fires through the bound `tapPoint`, on the recorded coordinate pair.
  expect(mockTapPoint).toHaveBeenCalledTimes(1);
  expect(mockTapPoint.mock.calls[0]?.[0]?.point).toEqual({ x: 540, y: 1356 });
  expect(session.pendingInteractionOutcome).toBeUndefined();
  expect(session.postGestureStabilization).toBeUndefined();
});

test('captureSnapshot composes post-gesture stabilization with Android freshness capture', async () => {
  const sessionName = 'android-post-gesture-freshness';
  const baselineNodes = inboxBaselineNodes(18);
  const changedNodes = buildNodes(
    androidTextRows(18, (row) => (row === 1 ? 'album-0' : `Album row ${row}`)),
  );
  const session = makeAndroidFreshnessSession(sessionName, 'click', baselineNodes);
  session.postGestureStabilization = {
    action: 'click',
    positionals: [],
    markedAt: Date.now(),
  };

  legacyDispatchCapture
    .mockResolvedValueOnce(androidCapture(baselineNodes, { rawNodeCount: 18, maxDepth: 1 }))
    .mockResolvedValueOnce(androidCapture(changedNodes, { rawNodeCount: 18, maxDepth: 1 }))
    .mockResolvedValueOnce(androidCapture(changedNodes, { rawNodeCount: 18, maxDepth: 1 }));

  const result = await captureSnapshot({
    device: androidDevice,
    session,
    flags: { snapshotInteractiveOnly: true },
    logPath: '/tmp/daemon.log',
  });

  expect(result.snapshot.nodes).toEqual(
    expect.arrayContaining([expect.objectContaining({ label: 'album-0' })]),
  );
  expect(legacyDispatchCapture.mock.calls.map((call) => call[1])).toEqual([
    'snapshot',
    'snapshot',
    'snapshot',
  ]);
  expect(session.androidSnapshotFreshness).toBeUndefined();
  expect(session.postGestureStabilization).toBeUndefined();
});

test('captureSnapshot composes pending outcome retry with Android freshness capture', async () => {
  const sessionName = 'android-lazy-outcome-freshness';
  const baselineNodes = inboxBaselineNodes(18);
  const session = makeAndroidFreshnessSession(sessionName, 'click', baselineNodes);
  session.pendingInteractionOutcome = {
    action: 'click',
    command: 'press',
    positionals: ['180', '330'],
    flags: { platform: 'android' },
    markedAt: Date.now(),
    attemptsRemaining: 2,
    preSignature: buildInteractionSurfaceSignature(baselineNodes),
  };

  legacyDispatchCapture
    .mockResolvedValueOnce(androidCapture([], { rawNodeCount: 18, maxDepth: 1 }))
    .mockResolvedValueOnce(
      androidCapture(
        [
          {
            index: 0,
            depth: 0,
            type: 'android.widget.Button',
            label: 'Create document',
            hittable: true,
          },
        ],
        { rawNodeCount: 1, maxDepth: 0 },
      ),
    );

  const result = await captureSnapshot({
    device: androidDevice,
    session,
    flags: { snapshotInteractiveOnly: true },
    logPath: '/tmp/daemon.log',
  });

  expect(result.snapshot.nodes).toEqual(
    expect.arrayContaining([expect.objectContaining({ label: 'Create document' })]),
  );
  expect(result.freshness).toEqual({
    action: 'click',
    retryCount: 1,
    staleAfterRetries: false,
    reason: undefined,
  });
  expect(legacyDispatchCapture.mock.calls.map((call) => call[1])).toEqual(['snapshot', 'snapshot']);
  expect(session.pendingInteractionOutcome).toBeUndefined();
  expect(session.androidSnapshotFreshness).toBeUndefined();
});
