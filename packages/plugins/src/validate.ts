import { AppError } from '@agent-device/kernel/errors';
import { isRecord } from '@agent-device/kernel/record';
import { isProviderId } from './discovery.ts';
import type { ConnectionProviderCapabilities } from '@agent-device/contracts/remote';
import type { ProviderDeviceRuntime } from '@agent-device/contracts/device';
import type { PlatformRuntimeProviderModule } from '@agent-device/contracts/platform-runtime-operations';
import {
  PROVIDER_PLUGIN_API_VERSION,
  ROUTING_PROVIDER_IDENTITIES,
  type AgentDevicePlugin,
} from './contract.ts';

const ENVIRONMENT_VARIABLE = /^[A-Z_][A-Z0-9_]*$/;

/** The one validation of what a plugin factory returned, whichever source produced it. */
export function validateAgentDevicePlugin(value: unknown): AgentDevicePlugin {
  if (!isRecord(value)) throw invalidPlugin('Plugin factory must return a plugin object');
  if (value.apiVersion !== PROVIDER_PLUGIN_API_VERSION) {
    throw new AppError('INVALID_ARGS', 'Plugin does not declare a compatible provider contract', {
      reason: 'incompatible_plugin',
      apiVersion: PROVIDER_PLUGIN_API_VERSION,
      hint: `Install a plugin release supporting provider plugin apiVersion ${PROVIDER_PLUGIN_API_VERSION}.`,
    });
  }
  if (!isProviderId(value.provider)) {
    throw invalidPlugin('Plugin provider must be a lowercase id such as "example"');
  }
  if (ROUTING_PROVIDER_IDENTITIES.includes(value.provider)) {
    throw new AppError('INVALID_ARGS', `Provider id is reserved for routing: ${value.provider}`, {
      reason: 'reserved_provider',
      provider: value.provider,
    });
  }
  assertCredentials(value.credentials);
  if (value.connection !== undefined) assertConnection(value.connection);
  if (typeof value.setup !== 'function') throw invalidPlugin('Plugin must provide setup(host)');
  return value as AgentDevicePlugin;
}

function assertCredentials(credentials: unknown): void {
  if (!isRecord(credentials) || !Array.isArray(credentials.variables)) {
    throw invalidPlugin('Plugin credentials must declare variables');
  }
  assertCredentialVariables(credentials.variables);
  if (credentials.byBackend === undefined) return;
  if (!isRecord(credentials.byBackend)) {
    throw invalidPlugin('Plugin credentials byBackend must map a lease backend to variables');
  }
  for (const names of Object.values(credentials.byBackend)) {
    if (!Array.isArray(names)) {
      throw invalidPlugin('Plugin credentials byBackend must map a lease backend to variables');
    }
    assertCredentialVariables(names);
  }
}

function assertCredentialVariables(variables: unknown): void {
  if (
    !Array.isArray(variables) ||
    !variables.every((name) => typeof name === 'string' && ENVIRONMENT_VARIABLE.test(name))
  ) {
    throw invalidPlugin('Plugin credential variables must list environment variable names');
  }
}

function assertConnection(connection: unknown): void {
  if (
    !isRecord(connection) ||
    connection.capabilities === undefined ||
    typeof connection.resolve !== 'function' ||
    typeof connection.verify !== 'function'
  ) {
    throw invalidPlugin('Plugin connection must provide capabilities, resolve and verify');
  }
  assertLocalConnectionCapabilities(connection.capabilities as ConnectionProviderCapabilities);
}

function assertLocalConnectionCapabilities(
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
    throw invalidPlugin('Plugin connection must declare local provider capabilities');
  }
}

/** The runtime a plugin built must answer to the provider id it registered. */
export function assertProviderRuntime(
  provider: string,
  runtime: ProviderDeviceRuntime | undefined,
  platformModule: PlatformRuntimeProviderModule | undefined,
): void {
  const owner = platformModule?.owner;
  if (
    runtime?.provider !== provider ||
    typeof runtime.shutdown !== 'function' ||
    !hasProviderFacets(runtime) ||
    owner?.kind !== 'provider-runtime' ||
    owner.provider !== provider ||
    typeof owner.instance !== 'string' ||
    owner.instance.trim().length === 0 ||
    typeof platformModule?.loadRuntime !== 'function'
  ) {
    throw invalidPlugin(`Plugin runtime owner does not match its provider: ${provider}`);
  }
}

function hasProviderFacets(runtime: ProviderDeviceRuntime): boolean {
  return (
    runtime.leaseLifecycle !== null &&
    typeof runtime.leaseLifecycle === 'object' &&
    (['ownsDevice', 'getInteractor', 'deviceInventoryProvider'] as const).every(
      (method) => typeof runtime[method] === 'function',
    )
  );
}

export function invalidPlugin(message: string): AppError {
  return new AppError('INVALID_ARGS', message, { reason: 'invalid_plugin' });
}
