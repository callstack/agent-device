import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { VegaTvRemoteKey } from '../../contracts/tv-remote.ts';
import {
  coerceExecResult,
  runCmd,
  whichCmd,
  type ExecOptions,
  type ExecResult,
} from '../../utils/exec.ts';
import { createScopedProvider } from '../../utils/scoped-provider.ts';

type VegaToolCommandExecutor = (
  cmd: string,
  args: string[],
  options?: ExecOptions,
) => Promise<ExecResult>;

type VegaToolAvailabilityChecker = (cmd: string) => Promise<boolean>;

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

type VegaCliAdapter = {
  runCommand: VegaToolCommandExecutor;
  whichCommand: VegaToolAvailabilityChecker;
};

const localVegaCliAdapter: VegaCliAdapter = {
  runCommand: async (cmd, args, options) =>
    await runCmd(cmd === 'vega' ? ((await resolveVegaCliExecutable()) ?? cmd) : cmd, args, options),
  whichCommand: async (cmd) =>
    cmd === 'vega' ? Boolean(await resolveVegaCliExecutable()) : await whichCmd(cmd),
};

const localVegaToolProvider = createLocalVegaToolProvider();
const vegaToolProviderScope = createScopedProvider(localVegaToolProvider);

export function createLocalVegaToolProvider(
  adapterOverrides: Partial<VegaCliAdapter> = {},
): VegaToolProvider {
  const adapter: VegaCliAdapter = {
    runCommand: coerceRunCommand(adapterOverrides.runCommand ?? localVegaCliAdapter.runCommand),
    whichCommand: adapterOverrides.whichCommand ?? localVegaCliAdapter.whichCommand,
  };
  const run = async (args: string[], options?: ExecOptions) =>
    await adapter.runCommand('vega', args, options);

  return {
    isAvailable: async () => await adapter.whichCommand('vega'),
    version: async (options) => await run(['--version'], options),
    listDevices: async (options) => await run(['device', 'list'], options),
    checkConnected: async (deviceId, options) =>
      await run(['device', 'is-connected', '--device', deviceId], options),
    launchApp: async (deviceId, appName, options) =>
      await run(['device', 'launch-app', '--device', deviceId, '--appName', appName], options),
    terminateApp: async (deviceId, appName, options) =>
      await run(['device', 'terminate-app', '--device', deviceId, '--appName', appName], options),
    pressRemote: async (deviceId, key, durationMs, options) =>
      await run(
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

function coerceRunCommand(runCommand: VegaToolCommandExecutor): VegaToolCommandExecutor {
  return async (cmd, args, options) => coerceExecResult(await runCommand(cmd, args, options));
}

async function resolveVegaCliExecutable(): Promise<string | undefined> {
  if (await whichCmd('vega')) return 'vega';
  const defaultInstall = path.join(os.homedir(), 'vega', 'bin', 'vega');
  try {
    await access(defaultInstall, constants.X_OK);
    return defaultInstall;
  } catch {
    return undefined;
  }
}
