import path from 'node:path';
import { beforeEach, expect, test, vi } from 'vitest';
import { mkdtempForTestSync } from '../../../__tests__/test-utils/tmp-dir.ts';
import { AppError } from '@agent-device/kernel/errors';
import { sleep } from '@agent-device/host-kit/retry';
import { makeIosSession } from '../../../__tests__/test-utils/session-factories.ts';
import { SessionStore } from '../../session-store.ts';
import { captureDivergenceObservation } from '@agent-device/replay-port/session-replay-divergence';
import { replayDivergenceForTest } from './replay-session-fixture.ts';
import {
  legacyDispatchCapture,
  resetLegacySnapshotCapture,
} from '../legacy-snapshot-capture-fixture.ts';
import { captureSnapshotWithInteractor } from '../../snapshot-interactor-capture.ts';

vi.mock('@agent-device/device-selection/dispatch-resolve', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@agent-device/device-selection/dispatch-resolve')>();
  return { ...actual, resolveTargetDevice: vi.fn() };
});
vi.mock('../../snapshot-interactor-capture.ts', () => ({
  captureSnapshotWithInteractor: vi.fn(),
}));
// Stubs the Android freshness-retry delay to a no-op so the retry branch runs without
// a wall-clock wait. Declared only here (and in the capture-policy sibling) — the two
// siblings that exercise a retry branch — so it cannot no-op the delay elsewhere.
vi.mock('@agent-device/host-kit/retry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent-device/host-kit/retry')>();
  return { ...actual, sleep: vi.fn(async () => {}) };
});

const mockDispatchCommand = legacyDispatchCapture;
beforeEach(() => {
  resetLegacySnapshotCapture(vi.mocked(captureSnapshotWithInteractor));
  vi.mocked(sleep).mockReset().mockResolvedValue(undefined);
});

// #1385 P2: the retry deadline is a DELAY-ONLY budget, not a per-attempt
// capture timeout — this loop does not itself bound how long a single
// capture attempt runs, only how much SLEEP time it spends between attempts
// (measured from the first attempt). This test proves that bound is real
// wall-clock behavior, not merely "run the fixed 7-entry delay list": each
// mocked capture attempt here advances the (fake) system clock by 5s to
// stand in for a slow capture, so the 12s deadline is exhausted after just 3
// attempts — far short of the 8 attempts (1 + 7 delays) the array alone would
// allow — proving the deadline, not the array length, is what stopped it.
test('captureDivergenceObservation retryLaunchRace: the 12s deadline bounds retries even when captures themselves consume wall-clock time', async () => {
  vi.useFakeTimers();
  try {
    const root = mkdtempForTestSync('agent-device-replay-divergence-deadline-');
    const sessionStore = new SessionStore(path.join(root, 'sessions'));
    const sessionName = 'default';
    sessionStore.set(sessionName, makeIosSession(sessionName, { appBundleId: 'com.example.app' }));

    mockDispatchCommand.mockImplementation(async () => {
      vi.setSystemTime(new Date(Date.now() + 5_000));
      throw new AppError(
        'COMMAND_FAILED',
        'Android snapshot helper returned insufficient foreground app content',
        { androidSnapshotHelperFailureReason: 'content-poor-app-window', retriable: true },
      );
    });

    const action = {
      ts: 0,
      command: 'click',
      positionals: ['label="Save"'],
      flags: {},
      result: { selectorChain: ['label="Save"', 'id="save"'] },
    };

    const observation = await captureDivergenceObservation({
      session: replayDivergenceForTest(sessionStore, sessionName).session!,
      observationStore: replayDivergenceForTest(sessionStore, sessionName).observationStore,
      logPath: path.join(root, 'daemon.log'),
      action,
      retryLaunchRace: true,
    });

    expect(observation.state).toBe('unavailable');
    // 1 initial attempt + 2 retries: the 3rd retry's pre-sleep remaining-budget
    // check sees the deadline already passed (3 x 5s = 15s > 12s) and breaks
    // BEFORE a 4th capture — not the 8 attempts the delay array alone permits.
    expect(mockDispatchCommand).toHaveBeenCalledTimes(3);
  } finally {
    vi.useRealTimers();
  }
});

test.each(['rebuild', 'retire'] as const)(
  'divergence capture binds observation authority before awaiting the native capture: %s',
  async (change) => {
    const root = mkdtempForTestSync('agent-device-divergence-lifetime-');
    const store = new SessionStore(path.join(root, 'sessions'));
    const session = makeIosSession('default', { appBundleId: 'com.example.app' });
    const ref = store.publish('cwd:worktree:default', session);
    const replay = replayDivergenceForTest(store, ref.address);
    let captured!: (value: Record<string, unknown>) => void;
    let started!: () => void;
    const capturing = new Promise<void>((resolve) => {
      started = resolve;
    });
    mockDispatchCommand.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          captured = resolve;
          started();
        }),
    );
    const pending = captureDivergenceObservation({
      session: replay.session!,
      observationStore: replay.observationStore,
      logPath: path.join(root, 'daemon.log'),
      action: { command: 'click', positionals: ['label="Save"'], flags: {} },
    });
    await capturing;
    let current;
    if (change === 'rebuild') current = store.update(ref, { appName: 'Latest app' });
    else {
      store.retire(ref);
      current = makeIosSession('default', { appBundleId: 'com.example.successor' });
      store.publish(ref.address, current);
    }
    captured({ nodes: [{ index: 0, depth: 0, type: 'Button', ref: 'e2', label: 'Save' }] });
    const result = await pending;
    expect(store.get(ref.address)).toBe(current);
    expect(store.get('default')).toBeUndefined();
    if (change === 'rebuild') {
      expect(result.state).toBe('available');
      expect(current.appName).toBe('Latest app');
      expect(current.snapshot?.nodes[0]?.label).toBe('Save');
    } else {
      expect(result.state).toBe('unavailable');
      expect(current.snapshot).toBeUndefined();
    }
  },
);

test.each(['rebuild', 'retire'] as const)(
  'capture retries retain their original lifetime through backoff: %s',
  async (change) => {
    const root = mkdtempForTestSync('agent-device-divergence-retry-lifetime-');
    const store = new SessionStore(path.join(root, 'sessions'));
    const session = makeIosSession('default', { appBundleId: 'com.example.app' });
    const ref = store.publish('cwd:worktree:default', session);
    const replay = replayDivergenceForTest(store, ref.address);
    let sleeping!: () => void;
    let resume!: () => void;
    const backoff = new Promise<void>((resolve) => {
      sleeping = resolve;
    });
    vi.mocked(sleep).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resume = resolve;
          sleeping();
        }),
    );
    mockDispatchCommand
      .mockResolvedValueOnce({
        nodes: [],
        quality: { state: 'sparse', backend: 'tree' },
      })
      .mockResolvedValueOnce({
        nodes: [{ index: 0, depth: 0, type: 'Button', ref: 'e2', label: 'Save' }],
      });
    const pending = captureDivergenceObservation({
      session: replay.session!,
      observationStore: replay.observationStore,
      logPath: path.join(root, 'daemon.log'),
      retryLaunchRace: true,
      action: { command: 'click', positionals: ['label="Save"'], flags: {} },
    });
    await backoff;
    let current;
    if (change === 'rebuild') current = store.update(ref, { appName: 'Latest app' });
    else {
      store.retire(ref);
      current = makeIosSession('default', { appBundleId: 'com.example.successor' });
      store.publish(ref.address, current);
    }
    resume();
    const result = await pending;
    expect(store.get(ref.address)).toBe(current);
    if (change === 'rebuild') {
      expect(mockDispatchCommand).toHaveBeenCalledTimes(2);
      expect(result.state).toBe('available');
      expect(current.appName).toBe('Latest app');
      expect(current.snapshot?.nodes[0]?.label).toBe('Save');
    } else {
      expect(mockDispatchCommand).toHaveBeenCalledTimes(1);
      expect(result.state).toBe('unavailable');
      expect(current.snapshot).toBeUndefined();
    }
  },
);
