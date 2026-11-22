import fs from 'node:fs';
import path from 'node:path';
import { AppError, type ReasonTable } from '@agent-device/kernel/errors';
import type { ConnectionProviderCapabilities } from '@agent-device/contracts/remote';

/**
 * Why a provider plugin was refused: discovery, the manifest, the store, and the registry all
 * answer from this one table.
 */
export const PLUGIN_REASONS = {
  // Two plugins claim one provider id, or a plugin claims an id that routing or a built-in provider owns.
  duplicateProvider: { reason: 'duplicate_provider' },
  // The package exports no plugin entry or declares no provider contract this build can load.
  incompatiblePlugin: { reason: 'incompatible_plugin' },
  // The plugin's manifest or code could not be read, resolved, or loaded.
  loadFailed: { reason: 'plugin_load_failed' },
  // The plugin's `setup(host)` threw, or registering what it returned failed.
  setupFailed: { reason: 'plugin_setup_failed' },
  // A plugin claims a provider id reserved for daemon routing, `cloud` or `proxy`.
  reservedProvider: { reason: 'reserved_provider' },
  // The plugin package or what its code returns breaks the plugin contract: an invalid manifest,
  // package version, provider id, credentials or connection, no default factory or `setup(host)`,
  // or a runtime or WebDriver descriptor that lacks a required field.
  invalidPlugin: { reason: 'invalid_plugin' },
} as const satisfies ReasonTable<'plugins'>;

/** One {@link PLUGIN_REASONS} spelling a plugin refusal may carry. */
export type PluginFailureReason = (typeof PLUGIN_REASONS)[keyof typeof PLUGIN_REASONS]['reason'];

/** Provider ids that name daemon routing, not a runtime a plugin can supply. */
export const ROUTING_PROVIDER_IDENTITIES: readonly string[] = ['cloud', 'proxy'];

const V1_PLUGIN_API_VERSION = 1;

/** A v1 plugin package: the manifest declares what the host reads before any plugin code runs. */
export type PluginManifest = {
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

const ENVIRONMENT_VARIABLE = /^[A-Z_][A-Z0-9_]*$/;

function invalidManifest(message: string): AppError {
  return new AppError('INVALID_ARGS', message, { reason: PLUGIN_REASONS.invalidPlugin.reason });
}

export function assertLocalConnectionCapabilities(
  policy: ConnectionProviderCapabilities | undefined,
): void {
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
    (policy.holdsCloudDevice !== undefined && typeof policy.holdsCloudDevice !== 'boolean') ||
    (policy.forgetsEndedConnectionLease !== undefined &&
      typeof policy.forgetsEndedConnectionLease !== 'boolean') ||
    policy.requiresRemoteDaemon
  ) {
    throw invalidManifest('Plugin connection must declare local provider capabilities');
  }
}

export function assertCredentialVariables(variables: unknown): void {
  if (
    variables !== undefined &&
    (!Array.isArray(variables) ||
      !variables.every((name) => typeof name === 'string' && ENVIRONMENT_VARIABLE.test(name)))
  ) {
    throw invalidManifest('Plugin credential variables must list environment variable names');
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
    declaration.apiVersion !== V1_PLUGIN_API_VERSION ||
    typeof declaration.provider !== 'string' ||
    !/^[a-z][a-z0-9-]*$/.test(declaration.provider) ||
    typeof declaration.entry !== 'string' ||
    !declaration.entry.startsWith('./')
  ) {
    throw new AppError('INVALID_ARGS', 'Package does not declare a compatible provider plugin', {
      reason: PLUGIN_REASONS.incompatiblePlugin.reason,
      apiVersion: V1_PLUGIN_API_VERSION,
      hint: `Install a plugin release supporting agentDevicePlugin.apiVersion ${V1_PLUGIN_API_VERSION}.`,
    });
  }
  resolvePluginEntry(directory, declaration.entry);
  assertLocalConnectionCapabilities(declaration.connection);
  assertCredentialVariables(declaration.credentialVariables);
  return manifest as PluginManifest;
}

export function resolvePluginEntry(directory: string, target: string): string {
  try {
    const root = fs.realpathSync(directory);
    const resolved = fs.realpathSync(path.resolve(directory, target));
    if (
      target.startsWith('./') &&
      resolved.startsWith(`${root}${path.sep}`) &&
      fs.statSync(resolved).isFile()
    ) {
      return resolved;
    }
  } catch {}
  throw new AppError('INVALID_ARGS', 'Plugin entry must be a readable file inside its package', {
    reason: PLUGIN_REASONS.loadFailed.reason,
    directory,
    entry: target,
  });
}
