import { AsyncLocalStorage } from 'node:async_hooks';
import type { DeviceInfo } from '../../utils/device.ts';
import type { RunnerCommand } from './runner-contract.ts';
import type {
  RunnerXctestrunArtifactState,
  RunnerXctestrunCacheKind,
  ExternalXctestRunnerOptions,
} from './runner-xctestrun.ts';

export type AppleRunnerCommandOptions = ExternalXctestRunnerOptions & {
  verbose?: boolean;
  logPath?: string;
  traceLogPath?: string;
  cleanStaleBundles?: boolean;
  startupTimeoutMs?: number;
  requestId?: string;
};

export type AppleRunnerLifecycleOptions = AppleRunnerCommandOptions & {
  buildTimeoutMs?: number;
  forceRunnerXctestrunRebuild?: boolean;
};

export type AppleRunnerPrewarmOptions = AppleRunnerLifecycleOptions;

export type AppleRunnerPrepareOptions = AppleRunnerLifecycleOptions & {
  healthTimeoutMs: number;
};

export type AppleRunnerPrepareResult = {
  runner: Record<string, unknown>;
  cache?: RunnerXctestrunCacheKind;
  artifact?: RunnerXctestrunArtifactState;
  buildMs?: number;
  connectMs: number;
  healthCheckMs: number;
  xctestrunPath?: string;
  recoveryReason?: string;
  failureReason?: string;
};

export type AppleRunnerCommandExecutor = (
  device: DeviceInfo,
  command: RunnerCommand,
  options: AppleRunnerCommandOptions,
) => Promise<Record<string, unknown>>;

export type AppleRunnerPrepareExecutor = (
  device: DeviceInfo,
  options: AppleRunnerPrepareOptions,
) => Promise<AppleRunnerPrepareResult>;

export type AppleRunnerPrewarmExecutor = (
  device: DeviceInfo,
  options: AppleRunnerPrewarmOptions,
) => Promise<void>;

export type AppleRunnerProvider = {
  /**
   * Executes a runner protocol command for an already resolved Apple target.
   * Scoped providers may adapt this call to a request-local transport.
   */
  runCommand: AppleRunnerCommandExecutor;
  /**
   * Proves a runner can answer a cheap command after any required local setup.
   * Command-only providers may omit this and let callers fall back to uptime.
   */
  prepare?: AppleRunnerPrepareExecutor;
  /**
   * Starts runner setup opportunistically. This must remain best-effort.
   */
  prewarm?: AppleRunnerPrewarmExecutor;
};

export type AppleRunnerProviderScopeOptions = {
  deviceId: string;
  requestId?: string;
};

type AppleRunnerProviderScope = {
  provider: AppleRunnerProvider;
  deviceId: string;
  requestId?: string;
};

const appleRunnerProviderScope = new AsyncLocalStorage<AppleRunnerProviderScope>();

export function createLocalAppleRunnerProvider(
  runCommand: AppleRunnerCommandExecutor,
  lifecycle: Pick<AppleRunnerProvider, 'prepare' | 'prewarm'> = {},
): AppleRunnerProvider {
  return { runCommand, ...lifecycle };
}

export function resolveAppleRunnerProvider(
  device: DeviceInfo,
  fallback: AppleRunnerProvider | AppleRunnerCommandExecutor,
  provider?: AppleRunnerProvider | AppleRunnerCommandExecutor,
  options: { requestId?: string } = {},
): AppleRunnerProvider {
  if (provider) return normalizeAppleRunnerProvider(provider);
  const scoped = resolveScopedAppleRunnerProvider(device, options);
  return scoped
    ? normalizeAppleRunnerProvider(scoped.provider)
    : normalizeAppleRunnerProvider(fallback);
}

function resolveScopedAppleRunnerProvider(
  device: DeviceInfo,
  options: { requestId?: string } = {},
): AppleRunnerProviderScope | undefined {
  const scoped = appleRunnerProviderScope.getStore();
  return scoped &&
    scoped.deviceId === device.id &&
    (scoped.requestId ? scoped.requestId === options.requestId : !options.requestId)
    ? scoped
    : undefined;
}

export async function withAppleRunnerProvider<T>(
  provider: AppleRunnerProvider | AppleRunnerCommandExecutor | undefined,
  options: AppleRunnerProviderScopeOptions,
  fn: () => Promise<T>,
): Promise<T> {
  if (!provider) return await fn();
  const scope = {
    provider: normalizeAppleRunnerProvider(provider),
    deviceId: options.deviceId,
    requestId: options.requestId,
  };
  return await appleRunnerProviderScope.run(scope, fn);
}

function normalizeAppleRunnerProvider(
  provider: AppleRunnerProvider | AppleRunnerCommandExecutor,
): AppleRunnerProvider {
  if (typeof provider === 'function') {
    return { runCommand: provider };
  }
  return provider;
}
