import { afterEach, expect, test } from 'vitest';
import { makeAndroidSession } from '../../__tests__/test-utils/session-factories.ts';
import { makeSessionStore } from '../../__tests__/test-utils/store-factory.ts';
import {
  clearRequestAbortRegistration,
  markRequestCanceled,
  registerRequestAbort,
} from '@agent-device/host-kit/request';
import { dispatchSnapshotDiffViaRuntime } from '../snapshot-diff-runtime.ts';
import { dispatchSnapshotViaRuntime } from '../snapshot-runtime.ts';
import { legacyDispatchCapture } from './legacy-snapshot-capture-fixture.ts';
import { snapshotRuntimeFixture } from './snapshot-runtime-fixture.ts';

/**
 * The capture double the snapshot runtime fixture's bound operation delegates to. Cancellation is
 * what these tests are about, so the double is the one place that can observe the signal the
 * request scope handed the binding.
 */
const captureMock = legacyDispatchCapture;

type Deferred = {
  promise: Promise<void>;
  resolve: () => void;
};

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

afterEach(() => {
  captureMock.mockReset();
});

for (const command of ['snapshot', 'diff snapshot'] as const) {
  test(`${command} forwards request cancellation into snapshot dispatch`, async () => {
    const sessionName = 'default';
    const sessionStore = makeSessionStore('agent-device-snapshot-cancellation-');
    sessionStore.set(sessionName, makeAndroidSession(sessionName));
    const requestId = `snapshot-cancellation-${command.replace(' ', '-')}`;
    const registration = registerRequestAbort(requestId);
    if (!registration) throw new Error('expected request abort registration');
    const dispatchEntered = deferred();
    const releaseDispatch = deferred();
    let observedSignal: AbortSignal | undefined;

    captureMock.mockImplementation(async (...args) => {
      const context = args[4] as { signal?: AbortSignal } | undefined;
      observedSignal = context?.signal;
      dispatchEntered.resolve();
      await releaseDispatch.promise;
      context?.signal?.throwIfAborted();
      return { nodes: [], truncated: false, backend: 'uiautomator' };
    });

    try {
      const input = {
        req: {
          command: command === 'snapshot' ? 'snapshot' : 'diff',
          positionals: command === 'snapshot' ? [] : ['snapshot'],
          token: 't',
          session: sessionName,
          meta: { requestId },
        },
        sessionName,
        logPath: '/tmp/agent-device-snapshot-cancellation.log',
        sessionStore,
      };
      const running =
        command === 'snapshot'
          ? dispatchSnapshotViaRuntime({ ...input, ...snapshotRuntimeFixture(requestId) })
          : dispatchSnapshotDiffViaRuntime({ ...input, ...snapshotRuntimeFixture(requestId) });
      await dispatchEntered.promise;
      markRequestCanceled(requestId);
      releaseDispatch.resolve();

      expect(observedSignal).toBe(registration.controller.signal);
      await expect(running).rejects.toBe(registration.controller.signal.reason);
    } finally {
      releaseDispatch.resolve();
      clearRequestAbortRegistration(registration);
    }
  });
}

for (const change of ['rebuild', 'replace'] as const) {
  test(`snapshot completion respects a scoped lifetime after ${change}`, async () => {
    const sessionStore = makeSessionStore();
    const address = 'cwd:snapshot-completion:default';
    const ref = sessionStore.publish(
      address,
      makeAndroidSession('default', { trace: { outPath: 'prior-trace', startedAt: 0 } }),
    );
    const entered = deferred();
    const release = deferred();
    captureMock.mockImplementation(async () => {
      entered.resolve();
      await release.promise;
      return {
        backend: 'uiautomator',
        nodes: [{ index: 0, type: 'Button', label: 'Captured' }],
      };
    });
    const running = dispatchSnapshotViaRuntime({
      req: { command: 'snapshot', positionals: [], token: 't', session: address },
      sessionName: address,
      logPath: '/dev/null',
      sessionStore,
      ...snapshotRuntimeFixture(),
    });
    const result = running.then(
      (response) => ({ response }),
      (error: unknown) => ({ error }),
    );
    try {
      await entered.promise;
      if (change === 'rebuild') {
        const trace = { outPath: 'intervening-trace', startedAt: 1 };
        sessionStore.update(ref, { trace });
        release.resolve();
        expect(await result).toMatchObject({ response: { ok: true } });
        const current = sessionStore.requireCurrent(ref);
        expect(current.trace).toBe(trace);
        expect(current.snapshot?.nodes[0]?.label).toBe('Captured');
      } else {
        sessionStore.retire(ref);
        const successor = sessionStore.publish(address, makeAndroidSession('default'));
        release.resolve();
        expect(await result).toMatchObject({
          error: { details: { reason: 'session_lifetime_ended' } },
        });
        expect(sessionStore.requireCurrent(successor)).toBe(successor.session);
        expect(successor.session.snapshot).toBeUndefined();
      }
      expect(sessionStore.lookup('default')).toBeUndefined();
    } finally {
      release.resolve();
      await result;
    }
  });
}
