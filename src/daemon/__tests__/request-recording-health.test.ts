import { test, expect, vi, beforeEach } from 'vitest';
import type { SessionState } from '../session-state.ts';
import { makeSessionStore } from '../../__tests__/test-utils/store-factory.ts';
import {
  createRequestExecutionScope,
  prepareLockedRequestScope,
} from '../request-execution-scope.ts';
import { LeaseRegistry } from '../lease-registry.ts';
import { makeTestScreenRecordingResource } from '../../__tests__/test-utils/screen-recording-live-handle.ts';

vi.mock('../../platform-runtime-apple-resources.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../platform-runtime-apple-resources.ts')>()),
  appleSessionObservation: { observeRunnerSession: vi.fn() },
}));

import { appleSessionObservation } from '../../platform-runtime-apple-resources.ts';
import { refreshRecordingHealth } from '../request-recording-health.ts';

const mockObserveRunnerSession = vi.mocked(appleSessionObservation.observeRunnerSession);

beforeEach(() => {
  mockObserveRunnerSession.mockReset();
});

function makeIosSimulatorSession(showTouches: boolean): SessionState {
  const session: SessionState = {
    name: 'default',
    createdAt: Date.now(),
    actions: [],
    device: {
      platform: 'apple',
      appleOs: 'ios',
      target: 'mobile',
      id: 'sim-1',
      name: 'iPhone 17 Pro',
      kind: 'simulator',
      booted: true,
    },
  };
  session.screenRecording = makeTestScreenRecordingResource(session, {
    backend: 'simctl recordVideo',
    outPath: '/tmp/demo.mp4',
    startedAt: Date.now() - 1_000,
    showTouches,
    runnerSessionId: 'runner-before',
  });
  return session;
}

test('runner-backed iOS recordings still invalidate on runner restarts', async () => {
  const session = makeIosSimulatorSession(true);
  session.device.kind = 'device';
  session.screenRecording = makeTestScreenRecordingResource(session, {
    backend: 'runner AVAssetWriter',
    showTouches: true,
    runnerSessionId: 'runner-before',
  });
  mockObserveRunnerSession.mockResolvedValue({
    alive: true,
    sessionId: 'runner-after',
  });

  const store = makeSessionStore();
  const ref = store.publish(session.name, session);
  await refreshRecordingHealth(store, ref);

  expect(mockObserveRunnerSession).toHaveBeenCalledWith('sim-1');
  expect(session.screenRecording?.handle.inspect().invalidatedReason).toBe(
    'iOS runner session restarted during recording',
  );
});

test.each([
  { snapshot: undefined, reason: 'iOS runner session exited during recording' },
  {
    snapshot: { alive: false, sessionId: 'runner-before' },
    reason: 'iOS runner session exited during recording',
  },
  { snapshot: { alive: true, sessionId: 'runner-before' }, reason: undefined },
])('recording health follows runner liveness: $snapshot', async ({ snapshot, reason }) => {
  const session = makeIosSimulatorSession(true);
  session.screenRecording = makeTestScreenRecordingResource(session, {
    backend: 'runner AVAssetWriter',
    showTouches: true,
    runnerSessionId: 'runner-before',
  });
  mockObserveRunnerSession.mockResolvedValue(snapshot);

  const store = makeSessionStore();
  const ref = store.publish(session.name, session);
  await refreshRecordingHealth(store, ref);

  expect(session.screenRecording.handle.inspect().invalidatedReason).toBe(reason);
});

test('a recording without a runner identity adopts the first live observation', async () => {
  const session = makeIosSimulatorSession(true);
  session.screenRecording = makeTestScreenRecordingResource(session, {
    backend: 'runner AVAssetWriter',
    showTouches: true,
  });
  mockObserveRunnerSession.mockResolvedValue({ alive: true, sessionId: 'runner-first' });

  const store = makeSessionStore();
  const ref = store.publish(session.name, session);
  await refreshRecordingHealth(store, ref);

  const recording = session.screenRecording.handle.inspect();
  expect(recording.runnerSessionId).toBe('runner-first');
  expect(recording.invalidatedReason).toBeUndefined();
});

test.each(['rebuild', 'retire', 'handle', 'token', 'generation'] as const)(
  'a held health observation respects the current lifetime and resource: %s',
  async (change) => {
    const store = makeSessionStore();
    const session = makeIosSimulatorSession(true);
    const active = makeTestScreenRecordingResource(session, {
      backend: 'runner AVAssetWriter',
      showTouches: true,
      runnerSessionId: 'runner-before',
    });
    session.screenRecording = active;
    const ref = store.publish('default', session);
    let finish!: (value: { alive: boolean; sessionId: string }) => void;
    mockObserveRunnerSession.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const observation = refreshRecordingHealth(store, ref);
    expect(mockObserveRunnerSession).toHaveBeenCalledWith('sim-1');
    if (change === 'rebuild') {
      store.update(ref, { appName: 'Intervening app' });
    } else if (change === 'retire') {
      store.retire(ref);
      store.publish('default', session);
    } else {
      const replacement = makeTestScreenRecordingResource(session, {
        backend: 'runner AVAssetWriter',
        showTouches: true,
        runnerSessionId: 'successor-runner',
      });
      store.update(ref, {
        screenRecording: {
          ...active,
          handle: change === 'handle' ? replacement.handle : active.handle,
          envelope: {
            ...active.envelope,
            fence: {
              ...active.envelope.fence,
              token: change === 'token' ? 'new-token' : active.envelope.fence.token,
              generation: active.envelope.fence.generation + (change === 'generation' ? 1 : 0),
            },
          },
        },
      });
    }
    const current = store.get('default')!;
    finish({ alive: true, sessionId: 'runner-after' });
    await observation;
    expect(store.get('default')).toBe(current);
    expect(active.handle.inspect().invalidatedReason).toBe(
      change === 'rebuild' ? 'iOS runner session restarted during recording' : undefined,
    );
    if (change === 'rebuild') expect(current.appName).toBe('Intervening app');
    else expect(current.screenRecording?.handle.inspect().invalidatedReason).toBeUndefined();
  },
);

test.each(['rebuild', 'retire'] as const)(
  'locked request preparation keeps its captured lifetime after runner observation: %s',
  async (change) => {
    const store = makeSessionStore();
    const session = makeIosSimulatorSession(true);
    session.screenRecording = makeTestScreenRecordingResource(session, {
      backend: 'runner AVAssetWriter',
      showTouches: true,
      runnerSessionId: 'runner-before',
    });
    const ref = store.publish('default', session);
    let observed!: () => void;
    const started = new Promise<void>((resolve) => {
      observed = resolve;
    });
    let finish!: (value: { alive: boolean; sessionId: string }) => void;
    mockObserveRunnerSession.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
          observed();
        }),
    );
    await using scope = await createRequestExecutionScope({
      req: { token: 'token', session: 'default', command: 'snapshot', positionals: [] },
      sessionStore: store,
      leaseRegistry: new LeaseRegistry(),
    });
    const prepared = scope.runLocked(() =>
      prepareLockedRequestScope({
        scope,
        sessionStore: store,
        trackDownloadableArtifact: () => 'artifact',
      }),
    );
    const outcome = prepared.then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    await started;
    let current;
    if (change === 'rebuild') current = store.update(ref, { appName: 'Latest app' });
    else {
      store.retire(ref);
      current = makeIosSimulatorSession(false);
      store.publish('default', current);
      store.setRuntimeHints('default', { metroPort: 8083 });
    }
    finish({ alive: true, sessionId: 'runner-before' });
    const result = await outcome;
    expect(store.get('default')).toBe(current);
    if (change === 'rebuild') {
      expect(result).toMatchObject({
        value: { type: 'scope', scope: { existingSession: current } },
      });
      expect(current.appName).toBe('Latest app');
      if ('value' in result && result.value.type === 'scope') {
        store.retire(ref);
        store.publish('default', { ...makeIosSimulatorSession(false), surface: 'app' });
        expect(result.value.scope.handlerContextFromFlags(undefined).surface).toBeUndefined();
      }
    } else {
      expect(result).toMatchObject({ error: { details: { reason: 'session_lifetime_ended' } } });
      expect(store.getRuntimeHints('default')).toEqual({ metroPort: 8083 });
    }
  },
);
