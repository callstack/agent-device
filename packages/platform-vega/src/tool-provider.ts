import type { VegaToolProvider } from '@agent-device/contracts/vega-tool-provider';
import { AppError } from '@agent-device/kernel/errors';
import { createScopedProvider } from '@agent-device/kernel/scoped-provider';
import type { VegaCommandOptions, VegaCommandRunner } from './command-host.ts';

/** Every Vega CLI call one request makes, shaped the way the Vega family asks for it. */
export function createVegaToolProvider(commands: VegaCommandRunner): VegaToolProvider {
  const run = async (args: string[], options?: VegaCommandOptions) =>
    await commands.run(args, options);
  return {
    isAvailable: async () => Boolean(await commands.resolveExecutable()),
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

/**
 * The scope default for callers that name no provider. Every composed route (the plugin interactor
 * wrapper, doctor's toolbox-bound provider) enters its own provider before a command runs, so
 * reaching this default means the caller forgot to bind one — refuse instead of spawning a CLI no
 * host was asked about (#3794).
 */
function unboundVegaToolProvider(): VegaToolProvider {
  const refuse = async (): Promise<never> => {
    throw new AppError('COMMAND_FAILED', 'The Vega CLI provider is not bound to a host.', {
      reason: 'vega-adapter-host-unbound',
    });
  };
  return {
    isAvailable: refuse,
    version: refuse,
    listDevices: refuse,
    checkConnected: refuse,
    launchApp: refuse,
    terminateApp: refuse,
    pressRemote: refuse,
  };
}

const vegaToolProviderScope = createScopedProvider(unboundVegaToolProvider());

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
