import type { FlagKey } from './flag-types.ts';

function flagKeys<const TKeys extends readonly FlagKey[]>(...keys: TKeys): TKeys {
  return keys;
}

export const SNAPSHOT_FLAGS = flagKeys(
  'snapshotInteractiveOnly',
  'snapshotDepth',
  'snapshotScope',
  'snapshotRaw',
);

export const SELECTOR_SNAPSHOT_FLAGS = flagKeys('snapshotDepth', 'snapshotScope', 'snapshotRaw');

export const METRO_PREPARE_FLAGS = flagKeys(
  'metroProjectRoot',
  'kind',
  'metroKind',
  'metroPublicBaseUrl',
  'metroProxyBaseUrl',
  'metroBearerToken',
  'metroPreparePort',
  'metroListenHost',
  'metroStatusHost',
  'metroStartupTimeoutMs',
  'metroProbeTimeoutMs',
  'metroRuntimeFile',
  'metroNoReuseExisting',
  'metroNoInstallDeps',
);

export const METRO_RELOAD_FLAGS = flagKeys('metroHost', 'metroPort', 'bundleUrl');
export const REPEATED_TOUCH_FLAGS = flagKeys(
  'count',
  'intervalMs',
  'holdMs',
  'jitterPx',
  'doubleTap',
);
// Interaction commands with the descriptor post-action observation trait use
// these flags for `--settle` (#1101). --timeout doubles as the settle deadline
// (flag-sourced budget on the interaction descriptors, mirroring wait's
// positional budget).
export const SETTLE_FLAGS = flagKeys('settle', 'settleQuietMs', 'timeoutMs');
export const REPLAY_FLAGS = flagKeys('replayUpdate', 'replayEnv');

// Which flags the CLI PARSER accepts on every command — a different axis from
// the common input keys in `commands/common-input-fields.ts`, which #2027
// unified into one table. Neither list contains the other: 25 of the 42 keys
// below (`remoteConfig`, `stateDir`, `daemonTransport`, `sessionIsolation`,
// `leaseBackend`, `sessionLock`, every `provider*` and `aws*`) never become
// structured command input, while the table's `cwd` and `debug` are not flags
// and its `deviceTarget` row is spelled `target` here. Deriving this list from
// that table would mean 25 rows carrying no schema, reader, or projection, so
// the two stay separate; the table declares only `envFlagKeys`, where a flag key
// names the environment variable an operator-owned input comes from.
export const COMMON_COMMAND_SUPPORTED_FLAG_KEYS = flagKeys(
  'remoteConfig',
  'stateDir',
  'daemonBaseUrl',
  'daemonAuthToken',
  'daemonTransport',
  'daemonServerMode',
  'tenant',
  'sessionIsolation',
  'runId',
  'leaseId',
  'leaseBackend',
  'sessionLock',
  'platform',
  'target',
  'device',
  'providerApp',
  'providerOsVersion',
  'providerProject',
  'providerBuild',
  'providerSessionName',
  'providerDeviceOrientation',
  'providerGeoLocation',
  'providerTimezone',
  'providerLanguage',
  'providerLocale',
  'providerNetworkProfile',
  'providerCustomNetwork',
  'providerNoResignApp',
  'awsProjectArn',
  'awsDeviceArn',
  'awsAppArn',
  'awsRegion',
  'awsInteractionMode',
  'udid',
  'serial',
  'iosSimulatorDeviceSet',
  'iosXctestrunFile',
  'iosXctestDerivedDataPath',
  'iosXctestEnvDir',
  'androidDeviceAllowlist',
  'session',
  // `--no-record` is genuinely common: it applies to every recordable command,
  // mutations included. `--record` is NOT — it only means anything for the
  // observation-only commands the repair-segment exclusion can drop
  // (snapshot/get/is/find), so it is scoped per-command via each schema's
  // `allowedFlags` instead of being accepted everywhere and silently ignored
  // (#1271 stage 2).
  'noRecord',
);

/**
 * The device/session selectors shared across device commands (a few take a subset:
 * connect has no --udid/--serial, device has no --session). They are part of
 * {@link COMMON_COMMAND_SUPPORTED_FLAG_KEYS}, not of {@link GLOBAL_FLAG_KEYS}, because they reach
 * device resolution rather than the CLI envelope). `help commands` renders them as their own
 * section: `--udid` used to appear only inside `help device`'s usage line, so the one flag that
 * pins a specific simulator among several with the same name was undiscoverable from the command
 * catalog (#2064).
 */
export const DEVICE_SELECTION_FLAG_KEYS: ReadonlySet<FlagKey> = new Set([
  'platform',
  'device',
  'udid',
  'serial',
  'session',
]);

export const GLOBAL_FLAG_KEYS: ReadonlySet<FlagKey> = new Set([
  'json',
  'config',
  'help',
  'version',
  'verbose',
  'cost',
  'responseLevel',
]);
