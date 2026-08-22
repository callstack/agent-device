import os from 'node:os';
import path from 'node:path';
import { expect, test, vi } from 'vitest';
import type { SnapshotQualityVerdict } from '@agent-device/kernel/snapshot';
import { makeIosSession } from '../../__tests__/test-utils/session-factories.ts';
import {
  recoveredSnapshotQualityWarning,
  renderSnapshotQualityWarnings,
} from '../../snapshot-quality/warnings.ts';
import {
  applyRecoveredWarningLatch,
  resolveRecoveredWarningLatch,
} from '../snapshot-quality-latch.ts';
import { dispatchSnapshotDiffViaRuntime } from '../snapshot-diff-runtime.ts';
import { dispatchSnapshotViaRuntime } from '../snapshot-runtime.ts';
import { SessionStore } from '../session-store.ts';
import type { SessionState } from '../types.ts';
import { snapshotRuntimeFixture } from './snapshot-runtime-fixture.ts';

const dispatchCommandMock = vi.hoisted(() => vi.fn());

vi.mock('../../core/dispatch.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../core/dispatch.ts')>();
  return {
    ...actual,
    dispatchCommand: dispatchCommandMock,
  };
});

vi.mock('../handlers/snapshot-interactor-capture.ts', async () => {
  const fixture = await import('./legacy-snapshot-capture-fixture.ts');
  return { captureSnapshotWithInteractor: fixture.captureSnapshotThroughLegacyDispatchFixture };
});

const FULL_WARNING = recoveredSnapshotQualityWarning('private-ax');

function deferredVerdict(): SnapshotQualityVerdict {
  return {
    state: 'recovered',
    backend: 'private-ax',
    reason: 'XCTest-backed snapshot tiers were deferred after recent slow accessibility work',
    reasonCode: 'deferred',
  };
}

function genuineRecoveredVerdict(): SnapshotQualityVerdict {
  return {
    state: 'recovered',
    backend: 'private-ax',
    reason: 'iOS XCTest snapshot failed while serializing the accessibility tree',
    reasonCode: 'ax-rejected',
  };
}

test('the injected warning is the exact line a genuine recovery renders', () => {
  // The latch exists to restore the warning an internal arming capture never rendered;
  // wording drift between the two paths would defeat one-shot deduplication.
  expect(renderSnapshotQualityWarnings(genuineRecoveredVerdict(), [])).toEqual([FULL_WARNING]);
});

test('resolveRecoveredWarningLatch transitions', () => {
  const app = 'com.example.app';

  // First deferred verdict with no latch held: inject once and hold the latch.
  const first = resolveRecoveredWarningLatch({
    verdict: deferredVerdict(),
    appBundleId: app,
    latch: undefined,
  });
  expect(first.warning).toBe(FULL_WARNING);
  expect(first.latch).toEqual({ appBundleId: app });

  // Held latch: further deferred verdicts stay quiet.
  const repeat = resolveRecoveredWarningLatch({
    verdict: deferredVerdict(),
    appBundleId: app,
    latch: first.latch,
  });
  expect(repeat.warning).toBeUndefined();
  expect(repeat.latch).toEqual({ appBundleId: app });

  // A genuine recovery renders through the runtime, so it sets the latch silently.
  const genuine = resolveRecoveredWarningLatch({
    verdict: genuineRecoveredVerdict(),
    appBundleId: app,
    latch: undefined,
  });
  expect(genuine.warning).toBeUndefined();
  expect(genuine.latch).toEqual({ appBundleId: app });

  // Healthy ends the penalty window; the next arming warns again.
  const healthy = resolveRecoveredWarningLatch({
    verdict: { state: 'healthy', backend: 'tree' },
    appBundleId: app,
    latch: first.latch,
  });
  expect(healthy.latch).toBeUndefined();

  // Sparse and verdict-less captures carry no penalty signal either way.
  const sparse = resolveRecoveredWarningLatch({
    verdict: { state: 'sparse', backend: 'private-ax' },
    appBundleId: app,
    latch: first.latch,
  });
  expect(sparse.warning).toBeUndefined();
  expect(sparse.latch).toEqual({ appBundleId: app });
  const absent = resolveRecoveredWarningLatch({
    verdict: undefined,
    appBundleId: app,
    latch: first.latch,
  });
  expect(absent.warning).toBeUndefined();
  expect(absent.latch).toEqual({ appBundleId: app });

  // The runner clears its penalty on app switch, so a latch held for another
  // app never suppresses the new app's first deferred verdict.
  const switched = resolveRecoveredWarningLatch({
    verdict: deferredVerdict(),
    appBundleId: 'com.example.other',
    latch: first.latch,
  });
  expect(switched.warning).toBe(FULL_WARNING);
  expect(switched.latch).toEqual({ appBundleId: 'com.example.other' });
});

test('Android helper quality never mutates the iOS penalty latch', () => {
  const latch = { appBundleId: 'com.example.app' };
  for (const state of ['healthy', 'recovered', 'sparse'] as const) {
    const decision = resolveRecoveredWarningLatch({
      verdict: {
        state,
        backend: 'android-helper',
        reasonCode: state === 'recovered' ? 'presentation-failed' : undefined,
      },
      appBundleId: 'com.example.app',
      latch,
    });
    expect(decision.warning).toBeUndefined();
    expect(decision.latch).toBe(latch);
  }
});

test('internal observation responses neither consume nor clear the latch', () => {
  const session = makeIosSession('default', { appBundleId: 'com.example.app' });

  const internal = applyRecoveredWarningLatch({
    session,
    data: {},
    verdict: deferredVerdict(),
    internalObservation: true,
  });
  expect(internal.warnings).toBeUndefined();
  expect(session.recoveredSnapshotWarningLatch).toBeUndefined();

  session.recoveredSnapshotWarningLatch = { appBundleId: 'com.example.app' };
  applyRecoveredWarningLatch({
    session,
    data: {},
    verdict: { state: 'healthy', backend: 'tree' },
    internalObservation: true,
  });
  expect(session.recoveredSnapshotWarningLatch).toEqual({ appBundleId: 'com.example.app' });
});

test('sessionless responses pass through unchanged', () => {
  const data = {};
  expect(
    applyRecoveredWarningLatch({
      session: undefined,
      data,
      verdict: deferredVerdict(),
      internalObservation: false,
    }),
  ).toBe(data);
});

function scenario() {
  const root = path.join(os.tmpdir(), `agent-device-quality-latch-${crypto.randomUUID()}`);
  const sessionStore = new SessionStore(path.join(root, 'sessions'));
  const sessionName = 'default';
  const session = makeIosSession(sessionName, { appBundleId: 'com.example.app' });
  sessionStore.set(sessionName, session);
  return { sessionStore, sessionName, logPath: path.join(root, 'daemon.log') };
}

function seedCapture(verdict: SnapshotQualityVerdict, label = 'Continue') {
  dispatchCommandMock.mockResolvedValue({
    backend: 'xctest',
    truncated: false,
    quality: verdict,
    nodes: [
      {
        index: 0,
        depth: 0,
        type: 'Button',
        label,
        rect: { x: 0, y: 0, width: 100, height: 44 },
        hittable: true,
      },
    ],
  });
}

async function dispatchPublicSnapshot(input: ReturnType<typeof scenario>) {
  return await dispatchSnapshotViaRuntime({
    req: { command: 'snapshot', positionals: [], token: 't', session: input.sessionName },
    sessionName: input.sessionName,
    logPath: input.logPath,
    sessionStore: input.sessionStore,
    ...snapshotRuntimeFixture(),
  });
}

function responseWarnings(response: Awaited<ReturnType<typeof dispatchSnapshotViaRuntime>>) {
  if (!response.ok) throw new Error('expected ok response');
  return (response.data?.warnings ?? []) as string[];
}

function storedLatch(
  input: ReturnType<typeof scenario>,
): SessionState['recoveredSnapshotWarningLatch'] {
  return input.sessionStore.get(input.sessionName)?.recoveredSnapshotWarningLatch;
}

test('an internally armed penalty warns once on the first public deferred snapshot', async () => {
  const input = scenario();
  seedCapture(deferredVerdict());

  // The internal capture that armed the penalty (settle observation, selector
  // resolution) rendered nothing; without the latch the deferred suppression
  // would hide the warning from the user entirely.
  const internal = await dispatchSnapshotViaRuntime({
    req: {
      command: 'snapshot',
      positionals: [],
      token: 't',
      session: input.sessionName,
      internal: { observationOnly: true },
    },
    sessionName: input.sessionName,
    logPath: input.logPath,
    sessionStore: input.sessionStore,
    ...snapshotRuntimeFixture(),
  });
  expect(responseWarnings(internal)).not.toContain(FULL_WARNING);
  expect(storedLatch(input)).toBeUndefined();

  const first = await dispatchPublicSnapshot(input);
  expect(responseWarnings(first).filter((line) => line === FULL_WARNING)).toHaveLength(1);
  expect(storedLatch(input)).toEqual({ appBundleId: 'com.example.app' });

  const second = await dispatchPublicSnapshot(input);
  expect(responseWarnings(second)).not.toContain(FULL_WARNING);
});

test('a healthy public capture re-arms the one-shot warning', async () => {
  const input = scenario();
  seedCapture(deferredVerdict());
  await dispatchPublicSnapshot(input);
  expect(storedLatch(input)).toEqual({ appBundleId: 'com.example.app' });

  seedCapture({ state: 'healthy', backend: 'tree' });
  const healthy = await dispatchPublicSnapshot(input);
  expect(responseWarnings(healthy)).not.toContain(FULL_WARNING);
  expect(storedLatch(input)).toBeUndefined();

  seedCapture(deferredVerdict());
  const rearmed = await dispatchPublicSnapshot(input);
  expect(responseWarnings(rearmed).filter((line) => line === FULL_WARNING)).toHaveLength(1);
});

test('an empty ref-scoped diff latches on the captured verdict, not the retained snapshot', async () => {
  const input = scenario();
  // The stored snapshot is healthy and carries the ref the diff will scope to;
  // the fresh capture is deferred and contains no node matching that scope, so
  // the empty scoped result deliberately retains the stored snapshot
  // (`shouldKeepCurrentSnapshot`) — a seam reading the verdict back from the
  // session would consult the retained healthy verdict and omit the warning.
  const session = input.sessionStore.get(input.sessionName)!;
  session.snapshot = {
    createdAt: Date.now(),
    snapshotQuality: { state: 'healthy', backend: 'tree' },
    nodes: [
      {
        index: 0,
        depth: 0,
        type: 'Button',
        ref: 'e1',
        label: 'Continue',
        rect: { x: 0, y: 0, width: 100, height: 44 },
        hittable: true,
      },
    ],
  };
  // The runner owns scope publication and returns the healthy empty projection for a miss.
  dispatchCommandMock.mockResolvedValue({
    backend: 'xctest',
    truncated: false,
    quality: deferredVerdict(),
    nodes: [],
  });

  const diff = await dispatchSnapshotDiffViaRuntime({
    req: {
      command: 'diff',
      positionals: [],
      token: 't',
      session: input.sessionName,
      flags: { snapshotScope: '@e1' },
    },
    sessionName: input.sessionName,
    logPath: input.logPath,
    sessionStore: input.sessionStore,
    ...snapshotRuntimeFixture(),
  });

  // The retention actually happened: the stored snapshot (and its healthy
  // verdict) survived the empty scoped capture.
  const retained = input.sessionStore.get(input.sessionName)?.snapshot;
  expect(retained?.nodes[0]?.label).toBe('Continue');
  expect(retained?.snapshotQuality?.state).toBe('healthy');

  expect(responseWarnings(diff).filter((line) => line === FULL_WARNING)).toHaveLength(1);
  expect(storedLatch(input)).toEqual({ appBundleId: 'com.example.app' });
});

test('an app switch supersedes the held latch through the dispatch seam', async () => {
  const input = scenario();
  seedCapture(deferredVerdict());
  await dispatchPublicSnapshot(input);
  expect(storedLatch(input)).toEqual({ appBundleId: 'com.example.app' });

  // The runner clears its penalty per target process, so a latch held for the
  // previous app must not silence the new app's first deferred verdict.
  input.sessionStore.get(input.sessionName)!.appBundleId = 'com.example.other';
  const switched = await dispatchPublicSnapshot(input);
  expect(responseWarnings(switched).filter((line) => line === FULL_WARNING)).toHaveLength(1);
  expect(storedLatch(input)).toEqual({ appBundleId: 'com.example.other' });
});

test('a genuine recovered render keeps later deferred captures quiet without doubling', async () => {
  const input = scenario();
  seedCapture(genuineRecoveredVerdict());

  const genuine = await dispatchPublicSnapshot(input);
  expect(responseWarnings(genuine).filter((line) => line === FULL_WARNING)).toHaveLength(1);
  expect(storedLatch(input)).toEqual({ appBundleId: 'com.example.app' });

  seedCapture(deferredVerdict());
  const deferred = await dispatchPublicSnapshot(input);
  expect(responseWarnings(deferred)).not.toContain(FULL_WARNING);
});
