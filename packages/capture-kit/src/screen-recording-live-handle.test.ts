import assert from 'node:assert/strict';
import { test, vi } from 'vitest';
import { createScreenRecordingLiveHandle } from './screen-recording-live-handle.ts';

test('keeps mutable gesture evidence on the live handle and settles cleanup once', async () => {
  let cleanupCalls = 0;
  const handle = createScreenRecordingLiveHandle(
    {
      backend: 'fixture',
      outPath: '/tmp/recording.mp4',
      startedAt: 1,
      scope: 'app',
      showTouches: true,
      recordOnlySession: false,
      gestureEvents: [],
    },
    {
      finish: async () => ({
        status: 'completed',
        result: {
          backend: 'fixture',
          outPath: '/tmp/recording.mp4',
          startedAt: 1,
          completedAt: 2,
          scope: 'app',
          showTouches: true,
          recordOnlySession: false,
        },
      }),
      forceCleanup: async () => {
        cleanupCalls += 1;
        return { status: 'cleaned' } as const;
      },
    },
  );
  handle.appendGestureEvents([{ kind: 'tap', tMs: 3, x: 4, y: 5 }]);
  handle.setRunnerSessionId('runner-1');
  handle.invalidate('runner restarted');
  assert.deepEqual(handle.inspect().gestureEvents, [{ kind: 'tap', tMs: 3, x: 4, y: 5 }]);
  assert.equal(handle.inspect().invalidatedReason, 'runner restarted');
  assert.equal(handle.inspect().runnerSessionId, 'runner-1');
  await handle.forceCleanup();
  await handle.forceCleanup();
  assert.equal(cleanupCalls, 1);
});

test('successful finish makes concurrent disposal inert', async () => {
  let resolveFinish: ((outcome: ReturnType<typeof completed>) => void) | undefined;
  const finish = vi.fn(
    async () =>
      await new Promise<ReturnType<typeof completed>>((resolve) => {
        resolveFinish = resolve;
      }),
  );
  const cleanup = vi.fn(async () => ({ status: 'cleaned' }) as const);
  const handle = createScreenRecordingLiveHandle(snapshot(), { finish, forceCleanup: cleanup });

  const finishing = handle.finish();
  const disposing = handle[Symbol.asyncDispose]();
  resolveFinish?.(completed());

  await assert.doesNotReject(async () => await disposing);
  assert.deepEqual(await finishing, completed());
  assert.equal(finish.mock.calls.length, 1);
  assert.equal(cleanup.mock.calls.length, 0);
});

test('failed finish permits one forced cleanup', async () => {
  const finish = vi.fn(async () => {
    throw new Error('finalization failed');
  });
  const cleanup = vi.fn(async () => ({ status: 'cleaned' }) as const);
  const handle = createScreenRecordingLiveHandle(snapshot(), { finish, forceCleanup: cleanup });

  await assert.rejects(async () => await handle.finish(), /finalization failed/);
  await handle[Symbol.asyncDispose]();
  await handle[Symbol.asyncDispose]();

  assert.equal(finish.mock.calls.length, 1);
  assert.equal(cleanup.mock.calls.length, 1);
});

function snapshot() {
  return {
    backend: 'fixture',
    outPath: '/tmp/recording.mp4',
    startedAt: 1,
    scope: 'app' as const,
    showTouches: false,
    recordOnlySession: false,
    gestureEvents: [],
  };
}

function completed() {
  return {
    status: 'completed' as const,
    result: {
      backend: 'fixture',
      outPath: '/tmp/recording.mp4',
      startedAt: 1,
      completedAt: 2,
      scope: 'app' as const,
      showTouches: false,
      recordOnlySession: false,
    },
  };
}
