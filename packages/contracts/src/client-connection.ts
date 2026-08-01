// The public API vocabulary for how a client reaches a daemon and selects a device.

import type {
  DaemonLockPolicy,
  DaemonRequest,
  DaemonResponse,
  LeaseBackend,
  ResponseLevel,
  SessionIsolationMode,
  SessionRuntimeHints,
} from '@agent-device/kernel/contracts';
import type { DeviceTarget, PlatformSelector } from '@agent-device/kernel/device';
import type {
  CloudProviderProfileFields,
  RemoteConnectionProfileFields,
} from './remote-config-fields.ts';

export type AgentDeviceDaemonTransport = (
  req: Omit<DaemonRequest, 'token'>,
) => Promise<DaemonResponse>;

export type AgentDeviceClientConfig = RemoteConnectionProfileFields &
  CloudProviderProfileFields & {
    session?: string;
    lockPolicy?: DaemonLockPolicy;
    lockPlatform?: PlatformSelector;
    requestId?: string;
    sessionIsolation?: SessionIsolationMode;
    leaseBackend?: LeaseBackend;
    leaseTtlMs?: number;
    runtime?: SessionRuntimeHints;
    cwd?: string;
    debug?: boolean;
    cost?: boolean;
    responseLevel?: ResponseLevel;
    iosXctestrunFile?: string;
    iosXctestDerivedDataPath?: string;
    iosXctestEnvDir?: string;
  };

export type AgentDeviceRequestOverrides = Pick<
  AgentDeviceClientConfig,
  | 'session'
  | 'lockPolicy'
  | 'lockPlatform'
  | 'requestId'
  | 'daemonBaseUrl'
  | 'daemonAuthToken'
  | 'daemonTransport'
  | 'daemonServerMode'
  | 'tenant'
  | 'sessionIsolation'
  | 'runId'
  | 'leaseId'
  | 'leaseBackend'
  | 'leaseProvider'
  | 'deviceKey'
  | 'clientId'
  | 'providerApp'
  | 'providerOsVersion'
  | 'providerProject'
  | 'providerBuild'
  | 'providerSessionName'
  | 'providerDeviceOrientation'
  | 'providerGeoLocation'
  | 'providerTimezone'
  | 'providerLanguage'
  | 'providerLocale'
  | 'providerNetworkProfile'
  | 'providerCustomNetwork'
  | 'providerNoResignApp'
  | 'awsProjectArn'
  | 'awsDeviceArn'
  | 'awsAppArn'
  | 'awsRegion'
  | 'awsInteractionMode'
  | 'leaseTtlMs'
  | 'cwd'
  | 'debug'
  | 'cost'
  | 'responseLevel'
  | 'iosXctestrunFile'
  | 'iosXctestDerivedDataPath'
  | 'iosXctestEnvDir'
>;

export type AgentDeviceIdentifiers = {
  session?: string;
  deviceId?: string;
  deviceName?: string;
  udid?: string;
  serial?: string;
  appId?: string;
  appBundleId?: string;
  package?: string;
};

export type AgentDeviceSelectionOptions = {
  platform?: PlatformSelector;
  target?: DeviceTarget;
  device?: string;
  udid?: string;
  serial?: string;
  iosSimulatorDeviceSet?: string;
  androidDeviceAllowlist?: string;
};

export type DeviceCommandBaseOptions = AgentDeviceRequestOverrides & AgentDeviceSelectionOptions;
