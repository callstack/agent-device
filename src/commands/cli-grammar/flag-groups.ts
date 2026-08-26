import type { FlagKey } from './flag-types.ts';
import { commonCommandSupportedFlagKeys } from '../command-input.ts';

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

export const COMMON_COMMAND_SUPPORTED_FLAG_KEYS: readonly FlagKey[] = flagKeys(
  'remoteConfig',
  'stateDir',
  'daemonTransport',
  'daemonServerMode',
  'sessionIsolation',
  'leaseBackend',
  'sessionLock',
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
  ...commonCommandSupportedFlagKeys(),
);

export const GLOBAL_FLAG_KEYS: ReadonlySet<FlagKey> = new Set([
  'json',
  'config',
  'help',
  'version',
  'verbose',
  'cost',
  'responseLevel',
]);
