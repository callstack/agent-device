import fs from 'node:fs';
import path from 'node:path';
import { AppError } from '@agent-device/kernel/errors';
import type { ConnectionProviderCapabilities } from '@agent-device/contracts/remote';

import {
  CLOUD_WEBDRIVER_PROVIDERS,
  type CloudWebDriverKnownProviderName,
} from '@agent-device/provider-webdriver/providers';

/** The one list of provider ids plugins cannot claim: connect routes and bundled runtimes. */
export const RESERVED_PLUGIN_PROVIDERS: readonly (
  | 'cloud'
  | 'proxy'
  | 'limrun'
  | CloudWebDriverKnownProviderName
)[] = ['cloud', 'proxy', ...Object.values(CLOUD_WEBDRIVER_PROVIDERS), 'limrun'];

const PROVIDER_PLUGIN_API_VERSION = 1;
type PluginManifest = {
  name: string;
  version: string;
  agentDevicePlugin: {
    apiVersion: number;
    provider: string;
    entry: string;
    connection?: ConnectionProviderCapabilities;
    credentialVariables?: string[];
  };
};

export function assertUniquePluginProviders(
  plugins: readonly PluginManifest[],
  reserved: readonly string[],
): void {
  const providers = new Set<string>(reserved);
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
  assertLocalConnectionPolicy(declaration.connection);
  assertCredentialVariables(declaration.credentialVariables);
  return manifest as PluginManifest;
}

function assertLocalConnectionPolicy(policy: ConnectionProviderCapabilities | undefined): void {
  if (policy === undefined) return;
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

function assertCredentialVariables(variables: unknown): void {
  if (
    variables !== undefined &&
    (!Array.isArray(variables) ||
      !variables.every((name) => typeof name === 'string' && /^[A-Z_][A-Z0-9_]*$/.test(name)))
  ) {
    throw new AppError(
      'INVALID_ARGS',
      'Plugin credentialVariables must list environment variable names',
    );
  }
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
