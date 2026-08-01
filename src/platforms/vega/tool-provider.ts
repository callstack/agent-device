import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { VegaTvRemoteKey } from '@agent-device/contracts/interaction';
import { runCmd, whichCmd, type ExecOptions, type ExecResult } from '../../utils/exec.ts';
import { createScopedProvider } from '../../utils/scoped-provider.ts';

export type VegaToolProvider = {
  isAvailable(): Promise<boolean>;
  version(options?: ExecOptions): Promise<ExecResult>;
  listDevices(options?: ExecOptions): Promise<ExecResult>;
  checkConnected(deviceId: string, options?: ExecOptions): Promise<ExecResult>;
  launchApp(deviceId: string, appName: string, options?: ExecOptions): Promise<ExecResult>;
  terminateApp(deviceId: string, appName: string, options?: ExecOptions): Promise<ExecResult>;
  pressRemote(
    deviceId: string,
    key: VegaTvRemoteKey,
    durationMs?: number,
    options?: ExecOptions,
  ): Promise<ExecResult>;
};

export type VegaCliAdapter = {
  run(args: string[], options?: ExecOptions): Promise<ExecResult>;
  isAvailable(): Promise<boolean>;
};

const localVegaCliAdapter: VegaCliAdapter = {
  run: async (args, options) =>
    await runCmd((await resolveVegaCliExecutable()) ?? 'vega', args, options),
  isAvailable: async () => Boolean(await resolveVegaCliExecutable()),
};

const localVegaToolProvider = createLocalVegaToolProvider();
const vegaToolProviderScope = createScopedProvider(localVegaToolProvider);

export function createLocalVegaToolProvider(
  adapter: VegaCliAdapter = localVegaCliAdapter,
): VegaToolProvider {
  return {
    isAvailable: async () => await adapter.isAvailable(),
    version: async (options) => await adapter.run(['--version'], options),
    listDevices: async (options) => await adapter.run(['device', 'list'], options),
    checkConnected: async (deviceId, options) =>
      await adapter.run(['device', 'is-connected', '--device', deviceId], options),
    launchApp: async (deviceId, appName, options) =>
      await adapter.run(
        ['device', 'launch-app', '--device', deviceId, '--appName', appName],
        options,
      ),
    terminateApp: async (deviceId, appName, options) =>
      await adapter.run(
        ['device', 'terminate-app', '--device', deviceId, '--appName', appName],
        options,
      ),
    pressRemote: async (deviceId, key, durationMs, options) =>
      await adapter.run(
        [
          'device',
          'run-cmd',
          '--device',
          deviceId,
          '--command',
          [
            'inputd-cli',
            'button_press',
            key,
            ...(durationMs !== undefined ? ['--holdDuration', String(durationMs)] : []),
          ].join(' '),
        ],
        options,
      ),
  };
}

export function resolveVegaToolProvider(provider?: VegaToolProvider): VegaToolProvider {
  return vegaToolProviderScope.resolve(provider);
}

export async function withVegaToolProvider<T>(
  provider: VegaToolProvider | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  return await vegaToolProviderScope.run(provider, fn);
}

let cachedVegaCliExecutable: string | undefined;

async function resolveVegaCliExecutable(): Promise<string | undefined> {
  if (cachedVegaCliExecutable) return cachedVegaCliExecutable;
  if (await whichCmd('vega')) {
    cachedVegaCliExecutable = 'vega';
    return cachedVegaCliExecutable;
  }
  const defaultInstall = path.join(os.homedir(), 'vega', 'bin', 'vega');
  try {
    await access(defaultInstall, constants.X_OK);
    cachedVegaCliExecutable = defaultInstall;
  } catch {
    return undefined;
  }
  return cachedVegaCliExecutable;
}
