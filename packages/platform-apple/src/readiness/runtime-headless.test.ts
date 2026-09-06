import { expect, test, vi } from 'vitest';
import type { PlatformRuntimeHost } from '@agent-device/contracts/platform-runtime-operations';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { platformRuntimeHostFixture } from '../runtime.fixtures.ts';
import { ensureAppleReady } from './runtime.ts';

type CommandCall = { executable: string; args: readonly string[] };

/** A host whose simctl reports Shutdown until the boot command runs, then
 * Booted (boot + bootstatus succeed); records every host.commands.run call
 * (the `open -a Simulator` surface). */
function coldBootHost(bootedFromStart = false): {
  host: PlatformRuntimeHost;
  commandCalls: CommandCall[];
} {
  const commandCalls: CommandCall[] = [];
  let booted = bootedFromStart;
  const host: PlatformRuntimeHost = {
    ...platformRuntimeHostFixture(),
    appleTools: {
      ...platformRuntimeHostFixture().appleTools,
      run: vi.fn(async (request: { args: readonly string[] }) => {
        if (request.args.includes('boot')) booted = true;
        return {
          stdout: JSON.stringify({
            devices: { ios: [{ udid: 'sim-1', state: booted ? 'Booted' : 'Shutdown' }] },
          }),
          stderr: '',
          exitCode: 0,
        };
      }),
    },
    commands: {
      ...platformRuntimeHostFixture().commands,
      run: async (request: { executable: string; args: readonly string[] }) => {
        commandCalls.push({ executable: request.executable, args: request.args });
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    } as PlatformRuntimeHost['commands'],
  };
  return { host, commandCalls };
}

function simulatorOpenedSimulator(calls: readonly CommandCall[]): boolean {
  return calls.some((c) => c.executable === 'open' && c.args.includes('Simulator'));
}

test('cold boot without headless opens the Simulator GUI app', async () => {
  const { host, commandCalls } = coldBootHost();
  await ensureAppleReady(host, simulatorShutdown(), new AbortController().signal);
  expect(simulatorOpenedSimulator(commandCalls)).toBe(true);
});

test('cold boot with headless skips the Simulator GUI app', async () => {
  const { host, commandCalls } = coldBootHost();
  await ensureAppleReady(host, simulatorShutdown(), new AbortController().signal, {
    headless: true,
  });
  expect(simulatorOpenedSimulator(commandCalls)).toBe(false);
});

test('warm boot never opens the Simulator GUI app regardless of headless', async () => {
  const { host, commandCalls } = coldBootHost(true);
  await ensureAppleReady(host, simulator({ booted: true }), new AbortController().signal, {
    headless: true,
  });
  await ensureAppleReady(host, simulator({ booted: true }), new AbortController().signal);
  expect(commandCalls).toHaveLength(0);
});

function simulator(overrides: Partial<DeviceInfo> = {}): DeviceInfo {
  return {
    platform: 'apple',
    appleOs: 'ios',
    kind: 'simulator',
    id: 'sim-1',
    name: 'iPhone 16',
    ...overrides,
  } as DeviceInfo;
}

function simulatorShutdown(): DeviceInfo {
  return simulator({ booted: false });
}
