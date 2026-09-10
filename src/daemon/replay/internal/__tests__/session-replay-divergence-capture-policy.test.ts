import './session-replay-divergence-retry.fixtures.ts';
import { divergenceFixture } from './session-replay-divergence.fixtures.ts';
import path from 'node:path';
import { beforeEach, expect, test } from 'vitest';
import { mkdtempForTestSync } from '../../../../__tests__/test-utils/tmp-dir.ts';
import { makeAndroidSession } from '../../../../__tests__/test-utils/session-factories.ts';
import { SessionStore } from '../../../session-store.ts';
import { replayDivergenceForTest } from './replay-session-fixture.ts';

const { buildReplayFailureDivergence, mockDispatchCommand, resetDivergenceCapture } =
  divergenceFixture;

// #1264 capture parity: the divergence capture must reach the device through the SAME
// `captureSnapshot` wrapper a plain `snapshot` uses (so it inherits Android freshness +
// post-action retry and can never be STALER than a snapshot), and it must build its
// flags from a fixed diagnostic policy — never from the failed action's narrowing flags.

beforeEach(resetDivergenceCapture);

// #1264 (capture parity, point 1): the divergence capture must go through the
// SAME `captureSnapshot` wrapper as a plain `snapshot`, so it inherits Android
// freshness + post-action retry. Otherwise a divergence could consume the first
// stale / app-scoped dump while a plain `snapshot` retries to the fresh
// full-window tree — a divergence STALER than `snapshot`. Here the session
// carries an active Android freshness marker (baselineCount 20); the first
// on-device dump is a stale, near-empty tree (sharp node-count drop, no
// meaningful content → the `sharp-drop` retry trigger), and only the RETRIED
// second dump contains the system overlay. The divergence must reflect the
// retried tree. The retry delay (`sleep`) is stubbed to a no-op at the top of
// this file, so the retry BRANCH runs without a real wall-clock wait.
test('buildReplayFailureDivergence: routes through the freshness-retry wrapper and uses the retried fresh tree, not the first stale dump (#1264 capture parity)', async () => {
  const root = mkdtempForTestSync('agent-device-replay-divergence-fresh-');
  const sessionStore = new SessionStore(path.join(root, 'sessions'));
  const sessionName = 'default';
  const appBundleId = 'com.callstack.agentdevicelab';
  const session = makeAndroidSession(sessionName, { appBundleId });
  // Active freshness marker: a navigation-sensitive action just ran, and the
  // pre-action baseline had 20 nodes, so a near-empty next dump is suspicious.
  session.androidSnapshotFreshness = {
    action: 'press',
    markedAt: Date.now(),
    baselineCount: 20,
    routeComparable: false,
  };
  sessionStore.set(sessionName, session);

  // Capture 1: stale, near-empty dump (a single bare view — no hittable/label/
  // id) → `sharp-drop` vs the 20-node baseline → triggers a retry.
  const staleDump = {
    nodes: [
      {
        index: 0,
        type: 'android.view.View',
        bundleId: appBundleId,
        rect: { x: 0, y: 0, width: 10, height: 10 },
      },
    ],
    truncated: false,
    backend: 'android',
  };
  // Capture 2: the fresh full-window tree, holding the app control AND the
  // separate-window system overlay's dismiss target.
  const freshDump = {
    nodes: [
      {
        index: 0,
        type: 'android.widget.Button',
        bundleId: appBundleId,
        label: 'App control',
        identifier: `${appBundleId}:id/control`,
        rect: { x: 20, y: 100, width: 200, height: 44 },
        hittable: true,
      },
      {
        index: 1,
        type: 'android.widget.ImageButton',
        bundleId: 'com.android.systemui',
        identifier: 'com.android.systemui:id/volume_new_ringer_active_icon_container',
        label: 'Ringer volume',
        rect: { x: 300, y: 300, width: 44, height: 44 },
        hittable: true,
      },
    ],
    truncated: false,
    backend: 'android',
  };
  mockDispatchCommand.mockReset();
  mockDispatchCommand.mockResolvedValueOnce(staleDump).mockResolvedValueOnce(freshDump);

  const action = {
    ts: 0,
    command: 'press',
    positionals: ['label="App control"'],
    flags: {},
    result: { selectorChain: ['label="App control"'] },
  };
  const divergence = await buildReplayFailureDivergence({
    error: { code: 'COMMAND_FAILED', message: 'not hittable' },
    action,
    index: 0,
    sourcePath: path.join(root, 'flow.ad'),
    sourceLine: 1,
    ...replayDivergenceForTest(sessionStore, sessionName),
    logPath: path.join(root, 'daemon.log'),
    responseLevel: 'default',
    planActions: [action],
    planDigest: 'test-plan-digest',
  });

  // The freshness wrapper retried past the stale dump (2 on-device captures).
  expect(mockDispatchCommand).toHaveBeenCalledTimes(2);

  expect(divergence.screen.state).toBe('available');
  const screen = divergence.screen as Extract<typeof divergence.screen, { state: 'available' }>;
  // The overlay only exists in the RETRIED capture, so its presence proves the
  // divergence used the fresh tree — parity with what a plain `snapshot` sees.
  expect(screen.refs.some((ref) => ref.label === 'Ringer volume')).toBe(true);
  expect(screen.refs.some((ref) => ref.label === 'App control')).toBe(true);
});

// #1264 (clean flags policy, point 2): a failed `snapshot --raw`/scoped/`-d`
// action must never narrow the DIAGNOSTIC divergence tree. The divergence
// capture builds its flags from a fixed policy (full-window, non-raw, default
// depth), NOT from the failed action's flags — so `snapshotRaw`/`snapshotScope`/
// `snapshotDepth` on the action do not reach the capture. This inspects the
// context handed to the snapshot dispatch and asserts those narrowing flags are
// dropped while the interactive-only policy is still applied.
test('buildReplayFailureDivergence: divergence capture drops the action snapshotRaw/scope/depth flags (#1264 clean flags policy)', async () => {
  const root = mkdtempForTestSync('agent-device-replay-divergence-flags-');
  const sessionStore = new SessionStore(path.join(root, 'sessions'));
  const sessionName = 'default';
  const appBundleId = 'com.callstack.agentdevicelab';
  sessionStore.set(sessionName, makeAndroidSession(sessionName, { appBundleId }));

  mockDispatchCommand.mockReset();
  mockDispatchCommand.mockResolvedValue({
    nodes: [
      {
        index: 0,
        type: 'android.widget.Button',
        bundleId: appBundleId,
        label: 'Submit',
        identifier: `${appBundleId}:id/submit`,
        rect: { x: 20, y: 100, width: 200, height: 44 },
        hittable: true,
      },
    ],
    truncated: false,
    backend: 'android',
  });

  // A failed action that itself requested a raw, ref-scoped, depth-limited
  // snapshot — none of which may reshape the divergence diagnostic tree.
  const action = {
    ts: 0,
    command: 'press',
    positionals: ['label="Submit"'],
    flags: { snapshotRaw: true, snapshotScope: '@e5', snapshotDepth: 2 },
    result: { selectorChain: ['label="Submit"'] },
  };
  await buildReplayFailureDivergence({
    error: { code: 'COMMAND_FAILED', message: 'not hittable' },
    action,
    index: 0,
    sourcePath: path.join(root, 'flow.ad'),
    sourceLine: 1,
    ...replayDivergenceForTest(sessionStore, sessionName),
    logPath: path.join(root, 'daemon.log'),
    responseLevel: 'default',
    planActions: [action],
    planDigest: 'test-plan-digest',
  });

  expect(mockDispatchCommand).toHaveBeenCalled();
  const context = mockDispatchCommand.mock.calls[0]?.[4] as
    | {
        snapshotRaw?: boolean;
        snapshotScope?: string;
        snapshotDepth?: number;
        snapshotInteractiveOnly?: boolean;
      }
    | undefined;
  // The action's narrowing flags are stripped by the fixed divergence policy.
  expect(context?.snapshotRaw).not.toBe(true);
  expect(context?.snapshotScope).toBeUndefined();
  expect(context?.snapshotDepth).toBeUndefined();
  // The interactive-only policy (press → interactive) is still applied.
  expect(context?.snapshotInteractiveOnly).toBe(true);
});
