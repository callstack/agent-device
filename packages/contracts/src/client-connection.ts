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

export type AgentDeviceDaemonTransportContext = {
  authToken?: string;
  /**
   * Cancels this one in-flight request. A built-in transport that sees an abort destroys the
   * request's connection, which makes the daemon mark the request canceled; the promise rejects
   * with the typed canceled-request error. A custom transport that ignores the signal keeps its
   * own cancellation contract, and the client still rejects the caller's promise on abort.
   */
  signal?: AbortSignal;
};

export type AgentDeviceDaemonTransport = (
  req: Omit<DaemonRequest, 'token'>,
  context?: AgentDeviceDaemonTransportContext,
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
  | 'providerAppiumVersion'
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
> & {
  /**
   * Cancels this one call. Already aborted: the call rejects without sending anything
   * (`details.dispatched: 'no'`). Aborted in flight: the request's connection closes, the daemon
   * marks the request canceled, and the promise rejects with the typed canceled-request error
   * (`details.reason: 'request_canceled'`). An abort is never a timeout: no runner sweep, no
   * daemon reset.
   *
   * The guarantee covers the daemon request, and the built-in transports enforce it; a custom
   * transport receives the signal on its context and may implement cancellation differently. Two
   * phases run outside it: a response-artifact download started after the response begins is not
   * canceled, and a canceled one-shot replay still runs the existing cleanup that may tear down a
   * daemon this client started.
   */
  signal?: AbortSignal;
};

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
