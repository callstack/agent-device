import type {
  DaemonServerMode,
  DaemonTransportPreference,
  LeaseBackend,
  SessionIsolationMode,
} from '@agent-device/kernel/contracts';

// The remote-config profile field groups that `CliFlags` is composed from.
//
// `remote/` owns reading and validating a profile; the flag vocabulary those fields become
// is a contract, and contracts/cli-flags.ts spreads both groups into `CliFlags` directly.

import type { MetroPrepareKind } from './metro.ts';

/**
 * Screen orientation a hosted provider session starts in. Distinct from `DeviceRotation`
 * (`contracts/device-rotation.ts`): that is a four-way runtime rotation command, this is the
 * two-way session-creation capability hosted providers accept.
 */
export const PROVIDER_DEVICE_ORIENTATIONS = ['portrait', 'landscape'] as const;
export type ProviderDeviceOrientation = (typeof PROVIDER_DEVICE_ORIENTATIONS)[number];

export type CloudProviderProfileFields = {
  providerApp?: string;
  providerOsVersion?: string;
  providerProject?: string;
  providerBuild?: string;
  providerSessionName?: string;
  providerDeviceOrientation?: ProviderDeviceOrientation;
  providerGeoLocation?: string;
  providerTimezone?: string;
  providerLanguage?: string;
  providerLocale?: string;
  providerNetworkProfile?: string;
  providerCustomNetwork?: string;
  providerNoResignApp?: boolean;
  awsProjectArn?: string;
  awsDeviceArn?: string;
  awsAppArn?: string;
  awsRegion?: string;
  awsInteractionMode?: 'INTERACTIVE' | 'NO_VIDEO' | 'VIDEO_ONLY';
};

export type RemoteConfigMetroOptions = {
  metroProjectRoot?: string;
  metroKind?: MetroPrepareKind;
  metroPublicBaseUrl?: string;
  metroProxyBaseUrl?: string;
  metroBearerToken?: string;
  metroPreparePort?: number;
  metroListenHost?: string;
  metroStatusHost?: string;
  metroStartupTimeoutMs?: number;
  metroProbeTimeoutMs?: number;
  metroRuntimeFile?: string;
  metroNoReuseExisting?: boolean;
  metroNoInstallDeps?: boolean;
  launchUrl?: string;
};

/**
 * How to reach a daemon and which lease/tenant the request belongs to.
 *
 * Sibling of `CloudProviderProfileFields` above, and here for the same reason: `remote/` owns
 * reading and validating a profile, but the field vocabulary is a contract that zones below
 * `remote/` are stated in terms of — the public API config is composed from both groups. Leaving
 * this one in `remote/` made every consumer of that composition declare itself in terms of a
 * rank-4 zone.
 */
export type RemoteConnectionProfileFields = {
  stateDir?: string;
  daemonBaseUrl?: string;
  daemonAuthToken?: string;
  daemonTransport?: DaemonTransportPreference;
  daemonServerMode?: DaemonServerMode;
  tenant?: string;
  sessionIsolation?: SessionIsolationMode;
  runId?: string;
  leaseId?: string;
  leaseBackend?: LeaseBackend;
  leaseProvider?: string;
  deviceKey?: string;
  clientId?: string;
};
