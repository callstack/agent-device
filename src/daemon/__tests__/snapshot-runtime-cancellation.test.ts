import { afterEach, expect, test, vi } from 'vitest';
import { makeAndroidSession } from '../../__tests__/test-utils/session-factories.ts';
import { makeSessionStore } from '../../__tests__/test-utils/store-factory.ts';
import {
  clearRequestAbortRegistration,
  markRequestCanceled,
  registerRequestAbort,
} from '../../request/cancel.ts';
import { dispatchSnapshotDiffViaRuntime, dispatchSnapshotViaRuntime } from '../snapshot-runtime.ts';
import { snapshotRuntimeFixture } from './snapshot-runtime-fixture.ts';

const dispatchCommandMock = vi.hoisted(() => vi.fn());

vi.mock('../../core/dispatch.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../core/dispatch.ts')>();
  return {
    ...actual,
    dispatchCommand: dispatchCommandMock,
  };
});

vi.mock('../handlers/snapshot-interactor-capture.ts', () => ({
  captureSnapshotWithInteractor: vi.fn(
    async ({ device, runnerContext, options }) =>
      await dispatchCommandMock(device, 'snapshot', [], undefined, {
        ...runnerContext,
        ...options,
        snapshotInteractiveOnly: options.interactiveOnly,
        snapshotPreferredBackend: options.preferredBackend,
        snapshotDepth: options.depth,
        snapshotScope: options.scope,
        snapshotRaw: options.raw,
        snapshotCustomActions: options.customActions,
        snapshotIncludeHiddenContentHints: options.includeHiddenContentHints,
      }),
  ),
}));

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
  dispatchCommandMock.mockReset();
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

    dispatchCommandMock.mockImplementation(async (...args: unknown[]) => {
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
          : dispatchSnapshotDiffViaRuntime(input);
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
