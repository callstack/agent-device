import type { VegaTvRemoteKey } from '@agent-device/contracts/tv-remote';
import { AppError } from '@agent-device/kernel/errors';
import { runCmd, type ExecOptions, type ExecResult } from '@agent-device/host-kit/command';
import type { HostEnvironment } from '@agent-device/kernel/source-value';
import { createScopedProvider } from '@agent-device/kernel/scoped-provider';
import { createVegaExecutableHostFromEnv, resolveVegaExecutable } from './vega-executable.ts';

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

/**
 * Builds the local CLI adapter for one host. It resolves the vega executable through the one
 * resolver (#3794), deriving PATH and home from that host's environment, and memoizes the answer
 * on this adapter instance, so a second runtime with a different host never runs the first
 * runtime's binary. A refusal is not memoized; only a found executable is, so a later install
 * still resolves.
 */
export function createLocalVegaCliAdapter(host: HostEnvironment): VegaCliAdapter {
  const executableHost = createVegaExecutableHostFromEnv(host.env);
  let resolvedExecutable: string | undefined;
  const resolveCliExecutable = async (): Promise<string | undefined> => {
    if (resolvedExecutable) return resolvedExecutable;
    resolvedExecutable = await resolveVegaExecutable(executableHost);
    return resolvedExecutable;
  };
  return {
    run: async (args, options) =>
      await runCmd((await resolveCliExecutable()) ?? 'vega', args, options),
    isAvailable: async () => Boolean(await resolveCliExecutable()),
  };
}

/**
 * The scope default for callers that name no host. Every composed route (the plugin interactor
 * wrapper, doctor's host-bound adapter) enters its own host-bound provider before a command
 * runs, so reaching this default means the caller forgot to bind one — refuse instead of reading
 * an ambient environment (#3794).
 */
function unboundVegaCliAdapter(): VegaCliAdapter {
  const refuse = async (): Promise<never> => {
    throw new AppError('COMMAND_FAILED', 'The Vega CLI adapter is not bound to a host.', {
      reason: 'vega-adapter-host-unbound',
    });
  };
  return { run: refuse, isAvailable: refuse };
}

const localVegaToolProvider = createLocalVegaToolProvider(unboundVegaCliAdapter());
const vegaToolProviderScope = createScopedProvider(localVegaToolProvider);

export function createLocalVegaToolProvider(adapter: VegaCliAdapter): VegaToolProvider {
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

export function hasScopedVegaToolProvider(): boolean {
  return vegaToolProviderScope.hasScope();
}

export async function withVegaToolProvider<T>(
  provider: VegaToolProvider | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  return await vegaToolProviderScope.run(provider, fn);
}
