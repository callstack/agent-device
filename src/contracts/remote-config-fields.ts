// The remote-config profile field groups that `CliFlags` is composed from.
//
// `remote/` owns reading and validating a profile; the flag vocabulary those fields become
// is a contract, and contracts/cli-flags.ts spreads both groups into `CliFlags` directly.

import type { MetroPrepareKind } from './metro.ts';

export type CloudProviderProfileFields = {
  providerApp?: string;
  providerOsVersion?: string;
  providerProject?: string;
  providerBuild?: string;
  providerSessionName?: string;
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
