import { expect, test, vi } from 'vitest';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { createLocalAppleToolProvider, withAppleToolProvider } from './core/tool-provider.ts';
import { createSimulatorSnapshotTargetResolver } from './snapshot-target.ts';

const ios = {
  platform: 'apple',
  appleOs: 'ios',
  id: 'ios-1',
  name: 'iPhone',
  kind: 'simulator',
  target: 'mobile',
  booted: true,
} as const satisfies DeviceInfo;
const app = 'com.example.app';
const signal = () => new AbortController().signal;

function targetFixture() {
  const state = { pid: 42, launch: 'launch-a', start: 'start-a' as string | null };
  const run = vi.fn(async (args: string[], _options?: { timeoutMs?: number }) => ({
    stdout:
      args[0] === 'spawn'
        ? `90\t0\tUIKitApplication:com.example.app.beta[wrong][rb-legacy]\n${state.pid}\t0\tUIKitApplication:${app}[${state.launch}][rb-legacy]`
        : JSON.stringify({
            devices: { 'com.apple.CoreSimulator.SimRuntime.iOS-26-0': [{ udid: ios.id }] },
          }),
    stderr: '',
    exitCode: 0,
  }));
  const runCommand = vi.fn(
    async (_tool: string, _args: string[], _options?: { timeoutMs?: number }) => ({
      stdout: state.start ?? '',
      stderr: '',
      exitCode: state.start ? 0 : 1,
    }),
  );
  const provider = createLocalAppleToolProvider({ simctl: { run }, runCommand });
  const resolve = createSimulatorSnapshotTargetResolver();
  return {
    state,
    run,
    runCommand,
    provider,
    resolve,
    discoveryCount: () => run.mock.calls.filter(([args]) => args[0] === 'spawn').length,
  };
}

test('an unchanged OS process reuses its exact app target without another simctl spawn', async () => {
  const fixture = targetFixture();
  await withAppleToolProvider(fixture.provider, async () => {
    const first = await fixture.resolve(ios, app, signal());
    const second = await fixture.resolve(ios, app, signal());
    expect(second).toBe(first);
    expect(first).toEqual({
      udid: ios.id,
      runtime: 'com.apple.CoreSimulator.SimRuntime.iOS-26-0',
      pid: 42,
      generation: `42:UIKitApplication:${app}[launch-a][rb-legacy]:start-a`,
      targetId: `${ios.id}:${app}`,
      processStartTime: 'start-a',
    });
    expect(fixture.discoveryCount()).toBe(1);
    expect(fixture.runCommand).toHaveBeenCalledTimes(2);
  });
});

test('PID reuse cannot reuse a target from a different OS process start', async () => {
  const fixture = targetFixture();
  await withAppleToolProvider(fixture.provider, async () => {
    const first = await fixture.resolve(ios, app, signal());
    fixture.state.start = 'start-b';
    const second = await fixture.resolve(ios, app, signal());
    expect(second.pid).toBe(first.pid);
    expect(second.generation).not.toBe(first.generation);
    expect(second.processStartTime).toBe('start-b');
    expect(fixture.discoveryCount()).toBe(2);
  });
});

test('a relaunched app resolves the replacement PID after the prior process disappears', async () => {
  const fixture = targetFixture();
  await withAppleToolProvider(fixture.provider, async () => {
    await fixture.resolve(ios, app, signal());
    fixture.runCommand.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 1 });
    fixture.state.pid = 84;
    fixture.state.launch = 'launch-b';
    fixture.state.start = 'start-b';
    expect(await fixture.resolve(ios, app, signal())).toMatchObject({
      pid: 84,
      processStartTime: 'start-b',
    });
    expect(fixture.discoveryCount()).toBe(2);
  });
});

test('unavailable OS identity never publishes or retains an unverified target', async () => {
  const fixture = targetFixture();
  await withAppleToolProvider(fixture.provider, async () => {
    await fixture.resolve(ios, app, signal());
    fixture.state.start = null;
    await expect(fixture.resolve(ios, app, signal())).rejects.toMatchObject({
      details: { reason: 'simulator-target-identity-unavailable' },
    });
    fixture.state.start = 'start-a';
    await fixture.resolve(ios, app, signal());
    expect(fixture.discoveryCount()).toBe(3);
  });
});

test('stale acquisition refresh explicitly bypasses an otherwise live cached target', async () => {
  const fixture = targetFixture();
  await withAppleToolProvider(fixture.provider, async () => {
    await fixture.resolve(ios, app, signal());
    fixture.state.pid = 84;
    fixture.state.launch = 'launch-b';
    const next = await fixture.resolve(ios, app, signal(), 'refresh');
    expect(next.pid).toBe(84);
    expect(fixture.discoveryCount()).toBe(2);
  });
});

test('target facts stay within their runtime owner', async () => {
  const fixture = targetFixture();
  await withAppleToolProvider(fixture.provider, async () => {
    await fixture.resolve(ios, app, signal());
    await createSimulatorSnapshotTargetResolver()(ios, app, signal());
    expect(fixture.discoveryCount()).toBe(2);
  });
});

test('an aborted request cannot reuse a cached target', async () => {
  const fixture = targetFixture();
  await withAppleToolProvider(fixture.provider, async () => {
    await fixture.resolve(ios, app, signal());
    const controller = new AbortController();
    controller.abort(new Error('request-ended'));
    await expect(fixture.resolve(ios, app, controller.signal)).rejects.toThrow('request-ended');
    expect(fixture.runCommand).toHaveBeenCalledTimes(1);
  });
});

function deferredSpawn(fixture: ReturnType<typeof targetFixture>) {
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const respond = fixture.run.getMockImplementation()!;
  fixture.run.mockImplementation(async (args: string[]) =>
    args[0] === 'spawn' ? await released.then(() => respond(args)) : await respond(args),
  );
  return release;
}

test('a slow discovery yields to the fallback after its wait budget and finishes in the background', async () => {
  const fixture = targetFixture();
  const release = deferredSpawn(fixture);
  vi.useFakeTimers();
  try {
    await withAppleToolProvider(fixture.provider, async () => {
      const pending = fixture.resolve(ios, app, signal());
      const rejected = expect(pending).rejects.toMatchObject({
        details: { reason: 'simulator-target-discovery-pending' },
      });
      await vi.advanceTimersByTimeAsync(1_500);
      await rejected;
      expect(fixture.discoveryCount()).toBe(1);

      release();
      await vi.advanceTimersByTimeAsync(0);
      // The finished discovery serves the next capture without a second simctl spawn.
      expect(await fixture.resolve(ios, app, signal())).toMatchObject({ pid: 42 });
      expect(fixture.discoveryCount()).toBe(1);
    });
  } finally {
    vi.useRealTimers();
  }
});

test('captures that arrive during discovery join it instead of spawning their own', async () => {
  const fixture = targetFixture();
  const release = deferredSpawn(fixture);
  await withAppleToolProvider(fixture.provider, async () => {
    const first = fixture.resolve(ios, app, signal());
    const second = fixture.resolve(ios, app, signal());
    release();
    const targets = await Promise.all([first, second]);
    expect(targets[1]).toBe(targets[0]);
    expect(fixture.discoveryCount()).toBe(1);
  });
});

test('a cancelled caller leaves discovery running for the next capture', async () => {
  const fixture = targetFixture();
  const release = deferredSpawn(fixture);
  await withAppleToolProvider(fixture.provider, async () => {
    const controller = new AbortController();
    const cancelled = fixture.resolve(ios, app, controller.signal);
    controller.abort(new Error('request-ended'));
    await expect(cancelled).rejects.toThrow('request-ended');

    release();
    expect(await fixture.resolve(ios, app, signal())).toMatchObject({ pid: 42 });
    expect(fixture.discoveryCount()).toBe(1);
  });
});

test('one discovery shares a single deadline across its simctl probes and the identity read', async () => {
  const fixture = targetFixture();
  const release = deferredSpawn(fixture);
  vi.useFakeTimers();
  try {
    await withAppleToolProvider(fixture.provider, async () => {
      const pending = fixture.resolve(ios, app, signal());
      pending.catch(() => undefined);
      // The spawn ran 13s of the 15s discovery deadline before answering.
      await vi.advanceTimersByTimeAsync(13_000);
      release();
      await vi.advanceTimersByTimeAsync(0);
      await expect(fixture.resolve(ios, app, signal())).resolves.toMatchObject({ pid: 42 });

      const spawnOptions = fixture.run.mock.calls.find(([args]) => args[0] === 'spawn')?.[1];
      expect(spawnOptions?.timeoutMs).toBe(15_000);
      const identityOptions = fixture.runCommand.mock.calls[0]?.[2];
      expect(identityOptions?.timeoutMs).toBeGreaterThan(0);
      expect(identityOptions?.timeoutMs).toBeLessThanOrEqual(2_000);
    });
  } finally {
    vi.useRealTimers();
  }
});

test('a failed runtime probe does not release the slot while the launch-job probe still runs', async () => {
  const fixture = targetFixture();
  const release = deferredSpawn(fixture);
  const respond = fixture.run.getMockImplementation()!;
  fixture.run.mockImplementation(async (args: string[], options) =>
    args[0] === 'list'
      ? { stdout: '', stderr: 'simctl list failed', exitCode: 1 }
      : await respond(args, options),
  );
  vi.useFakeTimers();
  try {
    await withAppleToolProvider(fixture.provider, async () => {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const pending = fixture.resolve(ios, app, signal());
        const rejected = expect(pending).rejects.toMatchObject({
          details: { reason: 'simulator-target-discovery-pending' },
        });
        await vi.advanceTimersByTimeAsync(1_500);
        await rejected;
      }
      expect(fixture.discoveryCount()).toBe(1);

      release();
      await vi.advanceTimersByTimeAsync(0);
      // The settled discovery reports the runtime failure and frees the slot for a fresh probe.
      await expect(fixture.resolve(ios, app, signal())).rejects.toMatchObject({
        details: { reason: 'simulator-runtime-probe-failed' },
      });
    });
  } finally {
    vi.useRealTimers();
  }
});
