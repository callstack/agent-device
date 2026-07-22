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

export const GLOBAL_FLAG_KEYS = new Set<FlagKey>([
  'json',
  'config',
  'help',
  'version',
  'verbose',
  'cost',
  'responseLevel',
]);
