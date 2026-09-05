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
  const run = vi.fn(async (args: string[]) => ({
    stdout:
      args[0] === 'spawn'
        ? `90\t0\tUIKitApplication:com.example.app.beta[wrong][rb-legacy]\n${state.pid}\t0\tUIKitApplication:${app}[${state.launch}][rb-legacy]`
        : JSON.stringify({
            devices: { 'com.apple.CoreSimulator.SimRuntime.iOS-26-0': [{ udid: ios.id }] },
          }),
    stderr: '',
    exitCode: 0,
  }));
  const runCommand = vi.fn(async () => ({
    stdout: state.start ?? '',
    stderr: '',
    exitCode: state.start ? 0 : 1,
  }));
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
