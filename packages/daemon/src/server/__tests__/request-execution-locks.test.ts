import { expect, test } from 'vitest';
import { createRequestExecutionLocks } from '../request-execution-locks.ts';

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
