import { expect, test, vi } from 'vitest';
import { createRequestExecutionLocks } from '../request-execution-locks.ts';

test.each(['initial', 'retained'] as const)(
  'cancellation ends a queued %s lock without running device work',
  async (kind) => {
    const locks = new Map<string, Promise<unknown>>();
    const controller = new AbortController();
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const owner = createRequestExecutionLocks({ locks, initialKeys: ['device:SIM-001'] }).run(
      async () => {
        entered();
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      },
    );
    await started;
    const queuedLocks = createRequestExecutionLocks({
      locks,
      initialKeys: kind === 'initial' ? ['device:SIM-001'] : ['session:queued'],
      scope: { signal: controller.signal },
    });
    const deviceWork = vi.fn();
    const queued = queuedLocks.run(async () => {
      if (kind === 'retained') await queuedLocks.retainDevice('SIM-001');
      deviceWork();
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    const reason = new Error('deadline');
    const refused = expect(queued).rejects.toBe(reason);
    controller.abort(reason);
    await refused;
    release();
    await owner;
    await createRequestExecutionLocks({ locks, initialKeys: ['device:SIM-001'] }).run(
      async () => {},
    );
    expect(deviceWork).not.toHaveBeenCalled();
    expect(locks.size).toBe(0);
  },
);

test('a dynamically retained device lock lasts until the owning request completes', async () => {
  const locks = new Map<string, Promise<unknown>>();
  const replayLocks = createRequestExecutionLocks({
    locks,
    initialKeys: ['session:replay'],
  });
  const externalLocks = createRequestExecutionLocks({
    locks,
    initialKeys: ['session:external', 'device:SIM-001'],
  });
  let finishReplay: () => void = () => {};
  const replayFinished = new Promise<void>((resolve) => {
    finishReplay = resolve;
  });
  let markDeviceRetained: () => void = () => {};
  const deviceRetained = new Promise<void>((resolve) => {
    markDeviceRetained = resolve;
  });

  const replayRun = replayLocks.run(async () => {
    await replayLocks.retainDevice('SIM-001');
    markDeviceRetained();
    await replayFinished;
  });
  await deviceRetained;

  let externalEntered = false;
  const externalRun = externalLocks.run(async () => {
    externalEntered = true;
  });
  await Promise.resolve();
  expect(externalEntered).toBe(false);

  finishReplay();
  await replayRun;
  await externalRun;
  expect(externalEntered).toBe(true);
});

test('retaining an initial device lock is reentrant within the request', async () => {
  const requestLocks = createRequestExecutionLocks({
    locks: new Map(),
    initialKeys: ['session:replay', 'device:SIM-001'],
  });

  await expect(
    requestLocks.run(async () => {
      await requestLocks.retainDevice('SIM-001');
      return 'done';
    }),
  ).resolves.toBe('done');
});
