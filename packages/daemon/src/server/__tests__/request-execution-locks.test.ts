import { expect, test, vi } from 'vitest';
import { createRequestExecutionLocks } from '../request-execution-locks.ts';
import type { RequestExecutionLockKey } from '../request-binding.ts';

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

/**
 * Runs two requests that each hold their initial locks, lets both start, then has each retain one
 * more device lock. Returns what each retention settled to: `retained` or the refusal.
 */
async function crossRetentions(
  first: { keys: RequestExecutionLockKey[]; retain: string },
  second: { keys: RequestExecutionLockKey[]; retain: string },
): Promise<unknown[]> {
  const locks = new Map<string, Promise<unknown>>();
  let started = 0;
  let markBothStarted: () => void = () => {};
  const bothStarted = new Promise<void>((resolve) => {
    markBothStarted = resolve;
  });
  const run = async (request: { keys: RequestExecutionLockKey[]; retain: string }) => {
    const requestLocks = createRequestExecutionLocks({ locks, initialKeys: request.keys });
    return await requestLocks.run(async () => {
      started += 1;
      if (started === 2) markBothStarted();
      await bothStarted;
      return await requestLocks.retainDevice(request.retain).then(
        () => 'retained',
        (error: unknown) => error,
      );
    });
  };
  return await Promise.all([run(first), run(second)]);
}

const BUSY = {
  code: 'DEVICE_IN_USE',
  details: { reason: 'DEVICE_EXECUTION_LOCK_BUSY' },
};

test('replays on two apps of one Mac that each open the other app are refused, not deadlocked', async () => {
  // Each replay runs in its existing app session, closes its app, and opens the other one.
  const outcomes = await crossRetentions(
    { keys: ['session:one', 'device:mac:app:com.example.one'], retain: 'mac:app:com.example.two' },
    { keys: ['session:two', 'device:mac:app:com.example.two'], retain: 'mac:app:com.example.one' },
  );
  expect(outcomes).toHaveLength(2);
  for (const outcome of outcomes) expect(outcome).toMatchObject(BUSY);
});

test('a replay that leaves its app for the whole Mac is refused while another request holds the Mac', async () => {
  const locks = new Map<string, Promise<unknown>>();
  const replayLocks = createRequestExecutionLocks({
    locks,
    initialKeys: ['session:replay', 'device:mac:app:com.example.one'],
  });
  // A fresh open of the same app in another session holds the Mac and waits for the app.
  const freshOpenLocks = createRequestExecutionLocks({
    locks,
    initialKeys: ['session:fresh', 'device:mac', 'device:mac:app:com.example.one'],
  });
  let replayHolding: () => void = () => {};
  const holding = new Promise<void>((resolve) => {
    replayHolding = resolve;
  });
  let continueReplay: () => void = () => {};
  const freshWaiting = new Promise<void>((resolve) => {
    continueReplay = resolve;
  });
  let freshEntered = false;

  const replayRun = replayLocks.run(async () => {
    replayHolding();
    await freshWaiting;
    return await replayLocks.retainDevice('mac').then(
      () => 'retained',
      (error: unknown) => error,
    );
  });
  await holding;
  const freshRun = freshOpenLocks.run(async () => {
    freshEntered = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(freshEntered).toBe(false);
  continueReplay();

  expect(await replayRun).toMatchObject({ ...BUSY, details: { ...BUSY.details, deviceId: 'mac' } });
  await freshRun;
  expect(freshEntered).toBe(true);
});

test('a second lock on the same Mac is taken while it is free, and other devices still wait', async () => {
  const locks = new Map<string, Promise<unknown>>();
  const replayLocks = createRequestExecutionLocks({
    locks,
    initialKeys: ['session:replay', 'device:mac:app:com.example.one'],
  });
  await expect(
    replayLocks.run(async () => {
      await replayLocks.retainDevice('mac:app:com.example.two');
      await replayLocks.retainDevice('mac');
      return 'done';
    }),
  ).resolves.toBe('done');

  // A lock on another device is still waited for, as before.
  const holder = createRequestExecutionLocks({ locks, initialKeys: ['device:SIM-002'] });
  let releaseHolder: () => void = () => {};
  const holderRun = holder.run(
    async () =>
      await new Promise<void>((resolve) => {
        releaseHolder = resolve;
      }),
  );
  const simLocks = createRequestExecutionLocks({ locks, initialKeys: ['device:SIM-001'] });
  const simRun = simLocks.run(async () => {
    await simLocks.retainDevice('SIM-002');
    return 'waited';
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  releaseHolder();
  await holderRun;
  await expect(simRun).resolves.toBe('waited');
});

test('a nested request is refused a busy lock on its parent Mac but still waits for another device', async () => {
  const locks = new Map<string, Promise<unknown>>();
  const holder = createRequestExecutionLocks({
    locks,
    initialKeys: ['device:mac:app:com.example.two', 'device:SIM-002'],
  });
  let releaseHolder: () => void = () => {};
  const holderRun = holder.run(
    async () =>
      await new Promise<void>((resolve) => {
        releaseHolder = resolve;
      }),
  );
  const parent = createRequestExecutionLocks({
    locks,
    initialKeys: ['session:batch', 'device:mac:app:com.example.one'],
  });

  const outcomes = await parent.run(async () => {
    // A batch step opening the other app takes the host and that app as its own initial locks.
    const sameMac = createRequestExecutionLocks({
      locks,
      initialKeys: ['session:batch', 'device:mac', 'device:mac:app:com.example.two'],
    });
    const refused = await sameMac.run(async () => 'ran').catch((error: unknown) => error);
    const otherDevice = createRequestExecutionLocks({ locks, initialKeys: ['device:SIM-002'] });
    const waited = otherDevice.run(async () => 'waited');
    await new Promise((resolve) => setTimeout(resolve, 10));
    releaseHolder();
    return [refused, await waited];
  });
  await holderRun;

  expect(outcomes[0]).toMatchObject({
    code: 'DEVICE_IN_USE',
    details: { reason: 'DEVICE_EXECUTION_LOCK_BUSY', deviceId: 'mac:app:com.example.two' },
  });
  expect(outcomes[1]).toBe('waited');
  // The refused step left nothing queued on the host.
  expect(locks.has('device:mac')).toBe(false);
});

test('a nested request retaining a lock its enclosing request holds re-enters it', async () => {
  const locks = new Map<string, Promise<unknown>>();
  const parent = createRequestExecutionLocks({
    locks,
    initialKeys: ['session:batch', 'device:mac:app:com.example.one'],
  });

  await expect(
    parent.run(async () => {
      // A batch step whose lock plan resolved no device reopens the same app.
      const step = createRequestExecutionLocks({ locks, initialKeys: ['session:batch'] });
      return await step.run(async () => {
        await step.retainDevice('mac:app:com.example.one');
        return 'reentered';
      });
    }),
  ).resolves.toBe('reentered');
});
