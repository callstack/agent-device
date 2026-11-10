import { AppError } from '@agent-device/kernel/errors';
import { PLATFORM_SELECTORS, type PlatformSelector } from '@agent-device/kernel/device';
import type { CliFlags } from '@agent-device/contracts/command';
import type { DaemonLockPolicy } from '@agent-device/kernel/contracts';

export type BindingSettings = {
  defaultPlatform?: CliFlags['platform'];
  lockPolicy?: DaemonLockPolicy;
};

type BindingPolicyOverrides = Pick<Partial<CliFlags>, 'sessionLock'>;

type LockableFlags = Pick<
  Partial<CliFlags>,
  | 'platform'
  | 'target'
  | 'device'
  | 'udid'
  | 'serial'
  | 'iosSimulatorDeviceSet'
  | 'androidDeviceAllowlist'
>;

type BindingOptions = {
  env: NodeJS.ProcessEnv;
  policyOverrides?: BindingPolicyOverrides;
  configuredPlatform?: CliFlags['platform'];
  configuredSession?: string;
  inheritedPlatform?: CliFlags['platform'];
};

export function applyDefaultPlatformBinding<T extends LockableFlags>(
  flags: T,
  options: BindingOptions,
): T {
  const settings = resolveBindingSettings(options);
  const nextFlags = { ...flags };

  if (settings.defaultPlatform && nextFlags.platform === undefined) {
    nextFlags.platform = settings.defaultPlatform as T['platform'];
  }

  return nextFlags;
}

export function resolveBindingSettings(options: BindingOptions): BindingSettings {
  const { env } = options;
  const defaultPlatform =
    options.inheritedPlatform ??
    options.configuredPlatform ??
    readConfiguredPlatform(env.AGENT_DEVICE_PLATFORM);
  const defaultSessionConfigured = hasConfiguredSession(
    options.configuredSession ?? env.AGENT_DEVICE_SESSION,
  );
  const lockMode = resolveLockMode(options.policyOverrides, env, defaultSessionConfigured);
  return {
    defaultPlatform,
    lockPolicy: lockMode,
  };
}

function resolveLockMode(
  overrides: BindingPolicyOverrides | undefined,
  env: NodeJS.ProcessEnv,
  defaultSessionConfigured: boolean,
): DaemonLockPolicy | undefined {
  const explicitPolicy = overrides?.sessionLock ?? readConflictMode(env.AGENT_DEVICE_SESSION_LOCK);
  if (explicitPolicy) {
    return explicitPolicy;
  }
  if (defaultSessionConfigured) {
    return 'reject';
  }
  return undefined;
}

function readConfiguredPlatform(raw: string | undefined): CliFlags['platform'] | undefined {
  if (raw === undefined) return undefined;
  const value = raw.trim().toLowerCase();
  if (!value) return undefined;
  if (isPlatformSelector(value)) return value;
  throw new AppError(
    'INVALID_ARGS',
    `Invalid AGENT_DEVICE_PLATFORM: ${raw}. Use one of: ${PLATFORM_SELECTORS.join(', ')}.`,
  );
}

function isPlatformSelector(value: string): value is PlatformSelector {
  return (PLATFORM_SELECTORS as readonly string[]).includes(value);
}

function readConflictMode(raw: string | undefined): DaemonLockPolicy | undefined {
  if (raw === undefined) return undefined;
  const value = raw.trim().toLowerCase();
  if (!value) return undefined;
  if (value === 'reject' || value === 'strip') {
    return value;
  }
  throw new AppError('INVALID_ARGS', `Invalid session lock mode: ${raw}. Use reject or strip.`);
}

function hasConfiguredSession(raw: string | undefined): boolean {
  return typeof raw === 'string' && raw.trim().length > 0;
}
