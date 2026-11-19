import { NATIVE_REPLAY_BACKEND } from '@agent-device/contracts/replay-execution';
import type { ReplayExecution } from '@agent-device/contracts/replay-execution';
import type { ReplayBackend } from '@agent-device/contracts/replay-backend';
import type {
  ReplayBackendSetup,
  ReplayExecutionSetup,
} from './replay-backend.ts';
import { AppError } from '@agent-device/kernel/errors';
import { isRecord } from '@agent-device/kernel/record';
import { isProviderId } from './discovery.ts';
import type { ConnectionProviderCapabilities } from '@agent-device/contracts/remote';
import type { ProviderDeviceRuntime } from '@agent-device/contracts/device';
import type { PlatformRuntimeProviderModule } from '@agent-device/contracts/platform-runtime-operations';
import {
  PLUGIN_API_VERSION,
  ROUTING_PROVIDER_IDENTITIES,
  type AgentDevicePlugin,
  type Contribution,
  type ProviderContribution,
} from './contract.ts';

const ENVIRONMENT_VARIABLE = /^[A-Z_][A-Z0-9_]*$/;

/**
 * The one validation of what a plugin factory returned, whichever source produced it: the whole
 * declaration is validated before any of its claims is published.
 */
export function validateAgentDevicePlugin(value: unknown): AgentDevicePlugin {
  if (!isRecord(value)) throw invalidPlugin('Plugin factory must return a plugin object');
  if (value.apiVersion !== PLUGIN_API_VERSION) throw incompatiblePluginApi(value.apiVersion);
  if (!Array.isArray(value.contributes) || value.contributes.length === 0) {
    throw invalidPlugin('Plugin must declare a nonempty contributes list');
  }
  const keys = new Set<string>();
  for (const contribution of value.contributes) {
    const key = claimKeyOfContribution(contribution);
    if (keys.has(key)) {
      throw invalidPlugin(`Plugin declares the same claim twice: ${key}`);
    }
    keys.add(key);
  }
  return value as AgentDevicePlugin;
}

/** A factory result on an older contract gets the typed incompatibility, without a shim. */
export function incompatiblePluginApi(declared: unknown): AppError {
  return new AppError('INVALID_ARGS', 'Plugin does not declare a compatible contract version', {
    reason: 'incompatible-plugin-api',
    apiVersion: PLUGIN_API_VERSION,
    ...(declared !== undefined ? { declaredApiVersion: declared } : {}),
    hint: `Install a plugin release supporting plugin contract apiVersion ${PLUGIN_API_VERSION}.`,
  });
}

/** The claim key a contribution names, after validating the contribution's own shape. */
export function claimKeyOfContribution(value: unknown): string {
  if (!isRecord(value)) throw invalidPlugin('Each contribution must be an object');
  switch (value.kind) {
    case 'provider':
      return `provider:${validateProviderContribution(value)}`;
    case 'replay-backend': {
      if (!isProviderId(value.backend) || typeof value.setup !== 'function') {
        throw invalidPlugin('A replay-backend contribution must declare a backend id and setup(host)');
      }
      return `replay-backend:${value.backend as string}`;
    }
    case 'replay-execution': {
      if (value.id !== NATIVE_REPLAY_BACKEND || typeof value.setup !== 'function') {
        throw invalidPlugin(
          `A replay-execution contribution must declare id ${NATIVE_REPLAY_BACKEND} and setup(host)`,
        );
      }
      return `replay-execution:${NATIVE_REPLAY_BACKEND}`;
    }
    default:
      throw invalidPlugin(`Unknown contribution kind: ${String(value.kind)}`);
  }
}

/** The claim keys a validated declaration expands into, in declaration order. */
export function claimKeysOf(plugin: AgentDevicePlugin): string[] {
  return plugin.contributes.map((contribution) => claimKeyOfContribution(contribution));
}

/** The `provider` contribution of a validated declaration; the registry claims it in the provider space. */
export function providerContributionOf(plugin: AgentDevicePlugin): ProviderContribution {
  const contribution = plugin.contributes.find(
    (entry): entry is ProviderContribution => entry.kind === 'provider',
  );
  if (!contribution) throw invalidPlugin('Plugin declares no provider contribution');
  return contribution;
}

function validateProviderContribution(value: Record<string, unknown>): string {
  if (!isProviderId(value.provider)) {
    throw invalidPlugin('Plugin provider must be a lowercase id such as "example"');
  }
  const provider = value.provider as string;
  if (ROUTING_PROVIDER_IDENTITIES.includes(provider)) {
    throw new AppError('INVALID_ARGS', `Provider id is reserved for routing: ${provider}`, {
      reason: 'reserved_provider',
      provider,
    });
  }
  assertCredentials(value.credentials);
  if (value.connection !== undefined) assertConnection(value.connection);
  if (typeof value.setup !== 'function') throw invalidPlugin('Plugin must provide setup(host)');
  return provider;
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

/** A format backend's setup must provide the lazy backend factory and nothing else. */
export function validateReplayBackendSetup(value: unknown): ReplayBackendSetup {
  if (
    !isRecord(value) ||
    (value.dispose !== undefined && typeof value.dispose !== 'function') ||
    value.execution !== undefined ||
    !isRecord(value.replayBackend) ||
    typeof value.replayBackend.create !== 'function'
  ) {
    throw invalidPlugin('Format backend setup must provide replayBackend.create(host)');
  }
  return value as ReplayBackendSetup;
}

/** Native execution's setup must provide the lazy execution factory and nothing else. */
export function validateReplayExecutionSetup(value: unknown): ReplayExecutionSetup {
  if (
    !isRecord(value) ||
    (value.dispose !== undefined && typeof value.dispose !== 'function') ||
    value.replayBackend !== undefined ||
    !isRecord(value.execution) ||
    typeof value.execution.create !== 'function'
  ) {
    throw invalidPlugin('Native ad execution setup must provide execution.create()');
  }
  return value as ReplayExecutionSetup;
}

export function validateReplayExecution(value: unknown): ReplayExecution {
  if (
    !isRecord(value) ||
    (['inspectAdReplay', 'runAdReplay', 'runReplayTestSuite'] as const).some(
      (name) => typeof value[name] !== 'function',
    )
  ) {
    throw invalidPlugin(
      'Native replay execution must provide inspection, replay and suite execution',
    );
  }
  return value as ReplayExecution;
}

export function validateReplayBackend(id: string, value: unknown): ReplayBackend {
  if (
    !isRecord(value) ||
    value.id !== id ||
    (['collectSourceFiles', 'inspectSource', 'runReplay', 'exportReplayScript'] as const).some(
      (name) => typeof value[name] !== 'function',
    )
  ) {
    throw invalidPlugin(`Replay plugin runtime does not match its backend: ${id}`);
  }
  return value as ReplayBackend;
}

export type { Contribution };
