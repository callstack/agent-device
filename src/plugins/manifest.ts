import fs from 'node:fs';
import path from 'node:path';
import { AppError } from '@agent-device/kernel/errors';
import type { ConnectionProviderCapabilities } from '../cli/connection/provider-policy.ts';

const PROVIDER_PLUGIN_API_VERSION = 1;
type PluginManifest = {
  name: string;
  version: string;
  agentDevicePlugin: {
    apiVersion: number;
    provider: string;
    entry: string;
    connection?: ConnectionProviderCapabilities;
  };
};

export function assertUniquePluginProviders(
  plugins: readonly PluginManifest[],
  reserved: readonly string[],
): void {
  const providers = new Set(reserved);
  for (const plugin of plugins) {
    const provider = plugin.agentDevicePlugin.provider;
    if (providers.has(provider))
      throw new AppError('INVALID_ARGS', `Duplicate provider plugin: ${provider}`);
    providers.add(provider);
  }
}

export function readPluginManifest(directory: string): PluginManifest {
  let manifest: PluginManifest;
  try {
    const file = path.join(directory, 'package.json');
    manifest = JSON.parse(fs.readFileSync(file, 'utf8')) as PluginManifest;
  } catch (error) {
    throw new AppError(
      'INVALID_ARGS',
      `Cannot read plugin manifest: ${directory}`,
      {},
      error as Error,
    );
  }
  const declaration = manifest?.agentDevicePlugin;
  if (
    typeof manifest?.name !== 'string' ||
    typeof manifest?.version !== 'string' ||
    !declaration ||
    declaration.apiVersion !== PROVIDER_PLUGIN_API_VERSION ||
    typeof declaration.provider !== 'string' ||
    !/^[a-z][a-z0-9-]*$/.test(declaration.provider) ||
    typeof declaration.entry !== 'string' ||
    !declaration.entry.startsWith('./')
  ) {
    throw new AppError('INVALID_ARGS', 'Package does not declare a compatible provider plugin', {
      reason: 'incompatible_plugin',
      apiVersion: PROVIDER_PLUGIN_API_VERSION,
      hint: `Install a plugin release supporting agentDevicePlugin.apiVersion ${PROVIDER_PLUGIN_API_VERSION}.`,
    });
  }
  resolvePluginEntry(directory, declaration.entry);
  if (declaration.connection !== undefined) {
    const policy = declaration.connection;
    if (
      !policy ||
      typeof policy !== 'object' ||
      policy.leaseKind !== 'direct-device-provider' ||
      [
        'requiresAppAttachment',
        'requiresRemoteDaemon',
        'supportsArtifacts',
        'supportsDeferredAppSelection',
        'supportsDirectPortReverse',
        'usesCloudWebDriverLease',
      ].some((key) => typeof policy[key as keyof ConnectionProviderCapabilities] !== 'boolean') ||
      policy.requiresRemoteDaemon
    ) {
      throw new AppError(
        'INVALID_ARGS',
        'Plugin connection must declare local provider capabilities',
      );
    }
  }
  return manifest as PluginManifest;
}

export function resolvePluginEntry(directory: string, entry: string): string {
  try {
    const root = fs.realpathSync(directory);
    const resolved = fs.realpathSync(path.resolve(directory, entry));
    if (resolved.startsWith(`${root}${path.sep}`) && fs.statSync(resolved).isFile())
      return resolved;
  } catch {}
  throw new AppError('INVALID_ARGS', 'Plugin entry must be a readable file inside its package', {
    directory,
    entry,
  });
}
