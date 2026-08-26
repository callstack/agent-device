import type { AppLogRuntimeHost } from '@agent-device/contracts/app-log-runtime';
import type { PlatformRequestScope } from '@agent-device/contracts/platform-runtime-host';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { vi } from 'vitest';

export const scope: PlatformRequestScope = {
  signal: new AbortController().signal,
  diagnostics: { emit: () => {} },
  progress: { report: () => {} },
};

export function appleDevice(overrides: Partial<DeviceInfo> = {}): DeviceInfo {
  return {
    platform: 'apple',
    appleOs: 'ios',
    id: 'apple-1',
    name: 'iPhone',
    kind: 'simulator',
    target: 'mobile',
    booted: true,
    ...overrides,
  };
}

export function hostFixture(
  options: {
    failProcessStart?: boolean;
    commandRun?: AppLogRuntimeHost['commands']['run'];
    appleToolRun?: AppLogRuntimeHost['appleTools']['run'];
  } = {},
) {
  const backgroundCommands: string[][] = [];
  let outputDisposed = false;
  let outputOpens = 0;
  let markerReads = 0;
  const startProcess: AppLogRuntimeHost['processes']['start'] = vi.fn(async ({ command }) => {
    if (command.kind !== 'host') throw new Error('Expected an Apple host command');
    backgroundCommands.push([command.request.executable, ...command.request.args]);
    if (options.failProcessStart) throw new Error('start failed');
    return {
      wait: new Promise<never>(() => {}),
      terminate: async () => {},
      [Symbol.asyncDispose]: async () => {},
    };
  });
  const host: AppLogRuntimeHost = {
    appleTools: {
      isXcrunAvailable: async () => true,
      run: async (request, signal) => {
        if (options.appleToolRun) return await options.appleToolRun(request, signal);
        return request.args.includes('get_app_container')
          ? { stdout: '', stderr: '', exitCode: 1 }
          : { stdout: '', stderr: '', exitCode: 0 };
      },
    },
    toolchains: { prepare: async () => undefined },
    artifacts: {
      resolveSession: () => ({ outputPath: '/tmp/app.log', pidPath: '/tmp/app-log.pid' }),
    },
    commands: {
      which: async () => undefined,
      run: async (request, signal) =>
        options.commandRun
          ? await options.commandRun(request, signal)
          : { stdout: '', stderr: '', exitCode: 0 },
    },
    outputs: {
      readTail: async () => '',
      openAppend: async () => {
        outputOpens += 1;
        return {
          write: async () => {},
          [Symbol.asyncDispose]: async () => {
            outputDisposed = true;
          },
        };
      },
    },
    processTransports: { resolve: async () => ({ mode: 'local', start: startProcess }) },
    processes: {
      start: startProcess,
      readMarker: async () => {
        markerReads += 1;
        return { status: 'missing' };
      },
      clearMarker: async () => {},
      inspect: async () => 'missing',
      terminate: async () => 'already-missing',
    },
    clock: { now: () => 10, sleep: async () => {} },
  };
  return {
    host,
    backgroundCommands,
    outputDisposed: () => outputDisposed,
    outputOpens: () => outputOpens,
    markerReads: () => markerReads,
  };
}
