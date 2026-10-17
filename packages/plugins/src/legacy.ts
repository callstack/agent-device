import { pathToFileURL } from 'node:url';
import { AppError } from '@agent-device/kernel/errors';
import { isRecord } from '@agent-device/kernel/record';
import type { EnvMap } from '@agent-device/kernel/source-value';
import type { ProviderDeviceRuntime } from '@agent-device/contracts/device';
import {
  PROVIDER_PLUGIN_API_VERSION,
  type AgentDevicePlugin,
  type PluginConnection,
  type PluginSetupResult,
} from './contract.ts';
import { createPluginHost, type ProviderPluginHost } from './host.ts';
import { resolvePluginEntry, type PluginManifest } from './manifest.ts';

type LegacyConnection = Pick<PluginConnection, 'resolve' | 'verify'>;

/**
 * Presents a v1 plugin as a v2 plugin until 0.22 removes v1. The manifest still declares the
 * provider, connection capabilities and credential variables, and the v1 factory still runs with
 * the host and returns `{ runtime, platformModule }` or `{ webDriver }`, so no v1 plugin changes.
 */
export function adaptLegacyPlugin(
  manifest: PluginManifest,
  directory: string,
  options: Record<string, unknown> | undefined,
): AgentDevicePlugin {
  const declaration = manifest.agentDevicePlugin;
  const runFactory = async (host: ProviderPluginHost): Promise<unknown> => {
    const module = await import(
      pathToFileURL(resolvePluginEntry(directory, declaration.entry)).href
    );
    if (typeof module.default !== 'function')
      throw new AppError('INVALID_ARGS', `Plugin must export a default factory: ${manifest.name}`, {
        reason: 'invalid_plugin',
      });
    return await (module.default as (host: ProviderPluginHost) => unknown)(host);
  };
  const withConnection = async <T>(
    env: EnvMap,
    run: (connection: LegacyConnection) => Promise<T> | T,
  ): Promise<T> => {
    const result = await runFactory(createPluginHost(env, options));
    try {
      const connection = isRecord(result) ? result.connection : undefined;
      if (
        !isRecord(connection) ||
        !isFunction(connection.resolve) ||
        !isFunction(connection.verify)
      ) {
        throw new AppError(
          'INVALID_ARGS',
          `Plugin connection must provide resolve and verify: ${manifest.name}`,
          { reason: 'invalid_plugin' },
        );
      }
      return await run(connection as LegacyConnection);
    } finally {
      const runtime = isRecord(result)
        ? (result.runtime as ProviderDeviceRuntime | undefined)
        : undefined;
      if (isFunction(runtime?.shutdown)) await Promise.allSettled([runtime.shutdown()]);
    }
  };
  return {
    apiVersion: PROVIDER_PLUGIN_API_VERSION,
    provider: declaration.provider,
    credentials: { variables: declaration.credentialVariables ?? [] },
    ...(declaration.connection
      ? {
          connection: {
            capabilities: declaration.connection,
            resolve: async (context) =>
              await withConnection(context.env, (connection) => connection.resolve(context)),
            verify: async (context) =>
              await withConnection(context.env, (connection) => connection.verify(context)),
          },
        }
      : {}),
    setup: async (host) => {
      const result = await runFactory(host);
      return (
        isRecord(result) && 'webDriver' in result ? { webDriver: result.webDriver } : result
      ) as PluginSetupResult;
    },
  };
}

function isFunction(value: unknown): value is (...args: never[]) => unknown {
  return typeof value === 'function';
}
