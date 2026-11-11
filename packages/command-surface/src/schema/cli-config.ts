import type { CliFlags } from '@agent-device/contracts/command';
import fs from 'node:fs';
import path from 'node:path';
import { AppError } from '@agent-device/kernel/errors';
import { isRecord } from '@agent-device/kernel/record';
import { mergeDefinedFlags } from './merge-flags.ts';
import { type FlagKey } from '@agent-device/command-registry/flag-types';
import { projectConfigFlagKeys } from '@agent-device/command-registry/flag-registry';
import { resolveUserConfigPath, resolveUserPath } from '@agent-device/host-kit/file';
import {
  getConfigurableOptionSpecs,
  getOptionSpec,
  parseOptionValueFromSource,
} from './option-schema.ts';
import { parseInstallSourceConfig } from '@agent-device/provision-kit/install-source-config';
import { RETIRED_SCREENSHOT_MAX_SIZE } from '@agent-device/contracts/capture';
import { type EnvMap } from '@agent-device/kernel/source-value';
import type { DaemonLockPolicy } from '@agent-device/kernel/contracts';
import { PLATFORM_SELECTORS, type PlatformSelector } from '@agent-device/kernel/device';

type ConfigDefaultsOptions = {
  command: string | null;
  cwd: string;
  cliFlags: CliFlags;
  env: EnvMap;
};

/**
 * The layer that set each resolved default: the config file it came from, or the environment
 * variable. Later layers overwrite earlier ones, so an entry names the layer that won.
 */
export type FlagValueSource = {
  kind: ConfigFileSource | 'env' | 'flag';
  /** Human-readable origin, e.g. `project config file /repo/agent-device.json`. */
  label: string;
};

export type FlagProvenance = Partial<Record<FlagKey, FlagValueSource>>;

export type ConfigBackedFlagDefaults = {
  flags: Partial<CliFlags>;
  provenance: FlagProvenance;
};

export function resolveConfigBackedFlagDefaultsWithProvenance(
  options: ConfigDefaultsOptions,
): ConfigBackedFlagDefaults {
  const env = options.env;
  const provenance: FlagProvenance = {};
  const flags: Partial<CliFlags> = {};
  for (const entry of resolveConfigPaths(options.cwd, options.cliFlags.config, env)) {
    const parsed = loadSingleConfigFile(entry);
    mergeDefinedFlags(flags, parsed);
    recordProvenance(provenance, parsed, { kind: entry.source, label: configFileLabel(entry) });
  }
  const envDefaults = readEnvFlagDefaults(env, options.command);
  mergeDefinedFlags(flags, envDefaults.flags);
  for (const [key, envName] of Object.entries(envDefaults.envNames)) {
    provenance[key as FlagKey] = { kind: 'env', label: `environment variable ${envName}` };
  }
  return { flags, provenance };
}

function recordProvenance(
  provenance: FlagProvenance,
  flags: Partial<CliFlags>,
  source: FlagValueSource,
): void {
  for (const [key, value] of Object.entries(flags)) {
    if (value !== undefined) provenance[key as FlagKey] = source;
  }
}

type ConfigFileSource = 'user' | 'project' | 'explicit';

type ConfigPath = { path: string; required: boolean; source: ConfigFileSource };

// Project config is repository-controlled, so a flag stays operator-only unless its
// own declaration sets `projectConfig: true`. This set derives from those declarations;
// admitting a new key to ./agent-device.json edits the declaration, not this file.
const PROJECT_CONFIG_FLAG_KEYS = projectConfigFlagKeys();

function resolveConfigPaths(
  cwd: string,
  explicitCliConfigPath: string | undefined,
  env: EnvMap,
): ConfigPath[] {
  const explicitConfig = explicitCliConfigPath ?? env.AGENT_DEVICE_CONFIG;
  if (explicitConfig) {
    return [
      { path: resolveInputPath(explicitConfig, cwd, env), required: true, source: 'explicit' },
    ];
  }
  return [
    { path: resolveUserConfigPath(env), required: false, source: 'user' },
    { path: path.resolve(cwd, 'agent-device.json'), required: false, source: 'project' },
  ];
}

function resolveInputPath(inputPath: string, cwd: string, env: EnvMap): string {
  return resolveUserPath(inputPath, { cwd, env });
}

function loadSingleConfigFile(entry: ConfigPath): Partial<CliFlags> {
  const { path: filePath, required } = entry;
  if (!fs.existsSync(filePath)) {
    if (required) {
      throw new AppError('INVALID_ARGS', `Config file not found: ${filePath}`);
    }
    return {};
  }

  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    throw new AppError('INVALID_ARGS', `Failed to read config file: ${filePath}`, {
      cause: error instanceof Error ? error.message : String(error),
    });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new AppError('INVALID_ARGS', `Invalid JSON in config file: ${filePath}`, {
      cause: error instanceof Error ? error.message : String(error),
    });
  }

  if (!isRecord(parsed)) {
    throw new AppError('INVALID_ARGS', `Config file must contain a JSON object: ${filePath}`);
  }

  return parseConfigObject(parsed as Record<string, unknown>, {
    source: entry.source,
    label: configFileLabel(entry),
  });
}

function configFileLabel(entry: ConfigPath): string {
  return `${entry.source === 'project' ? 'project ' : ''}config file ${entry.path}`;
}

// The `record` config key was released (v0.21.10) as a project/user-config default, but
// the repair-segment exclusion it feeds needs per-invocation provenance a config default
// cannot carry. The key is retired: `--record` stays a per-invocation flag, and a config
// file or environment still naming the key fails with this migration guidance rather
// than silently doing nothing.
const RETIRED_RECORD_CONFIG_KEY = {
  flagKey: 'record',
  envVar: 'AGENT_DEVICE_RECORD',
  migration:
    '--record is per-invocation only: pass --record on the command, or record: true in the SDK/MCP call, to keep a corrective read in a healed script',
} as const;

function parseConfigObject(
  source: Record<string, unknown>,
  origin: { source: ConfigFileSource; label: string },
): Partial<CliFlags> {
  const flags: Partial<CliFlags> = {};
  const entries = Object.entries(source).filter(
    ([key]) => key !== 'plugins' || origin.source !== 'user',
  );
  for (const [rawKey, rawValue] of entries) {
    if (rawKey === RETIRED_RECORD_CONFIG_KEY.flagKey) {
      throw new AppError(
        'INVALID_ARGS',
        `Config key "${rawKey}" in ${origin.label} was removed; ${RETIRED_RECORD_CONFIG_KEY.migration}.`,
      );
    }
    const key = rawKey as FlagKey;
    const spec = getOptionSpec(key);
    if (!spec) {
      if (rawKey === RETIRED_SCREENSHOT_MAX_SIZE.flagKey) {
        throw new AppError(
          'INVALID_ARGS',
          `Config key "${rawKey}" in ${origin.label} was removed; use "screenshotScale" (0.01-1) to downscale screenshots. Recordings capture at native resolution.`,
        );
      }
      throw new AppError('INVALID_ARGS', `Unknown config key "${rawKey}" in ${origin.label}.`);
    }
    if (!spec.configurable) {
      throw new AppError(
        'INVALID_ARGS',
        `Config key "${rawKey}" is not allowed in ${origin.label}. This key is not supported in config files.`,
      );
    }
    if (origin.source === 'project' && !PROJECT_CONFIG_FLAG_KEYS.has(key)) {
      throw new AppError(
        'INVALID_ARGS',
        `Config key "${rawKey}" is not allowed in ${origin.label}. Move it to ~/.agent-device/config.json, pass it with --config or AGENT_DEVICE_CONFIG, or provide it through CLI flags/environment variables.`,
      );
    }
    if (key === 'installSource') {
      flags.installSource = parseInstallSourceConfig(rawValue, origin.label);
      continue;
    }
    (flags as Record<string, unknown>)[key] = parseOptionValueFromSource(
      spec,
      rawValue,
      origin.label,
      rawKey,
    );
  }
  return flags;
}

// Commands that honored AGENT_DEVICE_SCREENSHOT_MAX_SIZE in released versions.
// A stale env var must fail closed for them (sizing must not silently vanish)
// while every other command keeps working.
const RETIRED_MAX_SIZE_ENV_COMMANDS = new Set(['screenshot', 'record']);

function readEnvFlagDefaults(
  env: EnvMap,
  command: string | null,
): { flags: Partial<CliFlags>; envNames: Partial<Record<FlagKey, string>> } {
  if (
    command !== null &&
    getOptionSpec(RETIRED_RECORD_CONFIG_KEY.flagKey)?.supportsCommand(command) === true &&
    typeof env[RETIRED_RECORD_CONFIG_KEY.envVar] === 'string' &&
    env[RETIRED_RECORD_CONFIG_KEY.envVar]!.trim().length > 0
  ) {
    throw new AppError(
      'INVALID_ARGS',
      `${RETIRED_RECORD_CONFIG_KEY.envVar} was removed; ${RETIRED_RECORD_CONFIG_KEY.migration}.`,
    );
  }
  const retiredEnvValue = env[RETIRED_SCREENSHOT_MAX_SIZE.envVar];
  if (
    command !== null &&
    RETIRED_MAX_SIZE_ENV_COMMANDS.has(command) &&
    typeof retiredEnvValue === 'string' &&
    retiredEnvValue.trim().length > 0
  ) {
    throw new AppError(
      'INVALID_ARGS',
      `${RETIRED_SCREENSHOT_MAX_SIZE.envVar} was removed. ${RETIRED_SCREENSHOT_MAX_SIZE.migration[command === 'record' ? 'record' : 'screenshot']}`,
    );
  }
  const flags: Partial<CliFlags> = {};
  const envNames: Partial<Record<FlagKey, string>> = {};
  for (const spec of getConfigurableOptionSpecs(command)) {
    if (spec.key === 'installSource') continue;
    const envValue = spec.env.names
      .map((name) => ({ name, value: env[name] }))
      .find((entry) => typeof entry.value === 'string' && entry.value.trim().length > 0);
    if (!envValue) continue;
    (flags as Record<string, unknown>)[spec.key] = parseOptionValueFromSource(
      spec,
      envValue.value as string,
      `environment variable ${envValue.name}`,
      envValue.name,
    );
    envNames[spec.key] = envValue.name;
  }
  return { flags, envNames };
}

/**
 * The session lock and default platform a request carries (`meta.lockPolicy`, `meta.lockPlatform`).
 * One policy for every caller: the CLI passes its parsed flags, and the MCP and AI SDK executor
 * passes only the operator's environment and config defaults, never a value from tool input.
 */
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
  env: EnvMap;
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
  env: EnvMap,
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

/**
 * The opt-in device pin (#2161). `agent-device.json` already sets `platform`/`device`/`udid`/`serial`
 * DEFAULTS, and a default stays overridable by design. Setting `devicePin: true` beside them turns
 * those configured selectors into a pin: a selector-less command still inherits them, and a request
 * that names a different value fails with a typed reason instead of silently retargeting.
 * The pin guides selection only; it is not an ownership claim (#1320 device claims are).
 *
 * Precedence: the pinned values are the selector defaults the config and environment layers resolve
 * to (user config, then project config, then `--config`, then `AGENT_DEVICE_*`; a later layer wins).
 * Everything above those layers (typed flags, batch steps, MCP input, remote config, saved
 * connection defaults) must repeat the pinned value or leave the key unset.
 */
const DEVICE_PIN_SELECTOR_KEYS = ['platform', 'device', 'udid', 'serial'] as const;

type DevicePinSelectorKey = (typeof DEVICE_PIN_SELECTOR_KEYS)[number];

type DevicePinSelector = Partial<Pick<CliFlags, DevicePinSelectorKey>>;

export const DEVICE_PIN_CONFLICT_REASON = 'device_pin_conflict';
export const DEVICE_PIN_WITHOUT_SELECTOR_REASON = 'device_pin_without_selector';

export type DevicePin = {
  /** The pinned selector values: every configured selector default while the pin is on. */
  selector: DevicePinSelector;
  /** Which layer turned the pin on (`devicePin: true` or `--device-pin`). */
  policySource: FlagValueSource;
};

const DEVICE_PIN_FLAG_SOURCE: FlagValueSource = { kind: 'flag', label: 'the --device-pin flag' };

/**
 * Reads the pin from resolved config/env defaults. `explicitDevicePin` is the typed `--device-pin`
 * value, when the caller has one. Returns `undefined` while the pin is off, so every existing
 * default keeps its overridable behavior. A pin with no selector to pin is a misconfiguration and
 * fails before any daemon is contacted.
 */
export function resolveDevicePin(
  defaults: ConfigBackedFlagDefaults,
  explicitDevicePin?: boolean,
): DevicePin | undefined {
  const enabled = explicitDevicePin ?? defaults.flags.devicePin;
  if (enabled !== true) return undefined;
  const policySource =
    explicitDevicePin === true ? DEVICE_PIN_FLAG_SOURCE : defaults.provenance.devicePin;
  if (!policySource) return undefined;
  const selector: DevicePinSelector = {};
  for (const key of DEVICE_PIN_SELECTOR_KEYS) {
    const value = defaults.flags[key];
    if (value !== undefined) (selector as Record<string, unknown>)[key] = value;
  }
  if (Object.keys(selector).length === 0) {
    throw new AppError(
      'INVALID_ARGS',
      `devicePin is set by ${policySource.label} but no platform, device, udid, or serial default is configured to pin. Add the selector beside it, or remove devicePin.`,
      { reason: DEVICE_PIN_WITHOUT_SELECTOR_REASON, pinSource: policySource.label },
    );
  }
  return { selector, policySource };
}

type DevicePinRequest = {
  flags?: Readonly<Record<string, unknown>> & {
    batchSteps?: ReadonlyArray<{ flags?: Readonly<Record<string, unknown>> }>;
  };
};

type DevicePinConflict = {
  key: DevicePinSelectorKey;
  pinned: string;
  requested: string;
  /** The 1-based batch step that names the value; absent for the request's own flags. */
  step?: number;
};

/**
 * Fails when a finished daemon request names a selector the pin contradicts, in its own flags or
 * in any batch step's flags, whatever layer set the value. A value that repeats the pin, or a key
 * the pin leaves open (for example `udid` under a pinned `device` name), refines the pin and
 * passes; the daemon's selection still has to satisfy both.
 */
export function assertRequestHonorsDevicePin(pin: DevicePin, request: DevicePinRequest): void {
  const conflicts = findDevicePinConflicts(pin, request.flags);
  request.flags?.batchSteps?.forEach((step, index) => {
    conflicts.push(...findDevicePinConflicts(pin, step.flags, index + 1));
  });
  if (conflicts.length === 0) return;
  const first = conflicts[0]!;
  const pinnedDescription = describeSelector(pin.selector);
  const where = first.step === undefined ? '' : `Batch step ${first.step}: `;
  const message =
    `${where}${first.key} ${JSON.stringify(first.requested)} conflicts with the device pin ` +
    `from ${pin.policySource.label}, which pins ${pinnedDescription}. ` +
    `Edit or remove "devicePin" in that config to target another device.`;
  throw new AppError('INVALID_ARGS', message, {
    reason: DEVICE_PIN_CONFLICT_REASON,
    pin: { ...pin.selector },
    pinSource: pin.policySource.label,
    conflicts,
    hint: `This project pins ${pinnedDescription} (${pin.policySource.label}). Drop the conflicting selector to use the pinned device, or change the pin in that config.`,
  });
}

function findDevicePinConflicts(
  pin: DevicePin,
  flags: Readonly<Record<string, unknown>> | undefined,
  step?: number,
): DevicePinConflict[] {
  if (!flags) return [];
  return DEVICE_PIN_SELECTOR_KEYS.flatMap((key) => {
    const requested = flags[key];
    const pinned = pin.selector[key];
    if (typeof requested !== 'string' || pinned === undefined) return [];
    if (requested.trim() === pinned.trim()) return [];
    return [{ key, pinned, requested, ...(step === undefined ? {} : { step }) }];
  });
}

function describeSelector(selector: DevicePinSelector): string {
  return DEVICE_PIN_SELECTOR_KEYS.filter((key) => selector[key] !== undefined)
    .map((key) => `${key} ${JSON.stringify(selector[key])}`)
    .join(', ');
}
