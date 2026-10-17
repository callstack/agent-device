// The public API vocabulary for how a client reaches a daemon and selects a device.

import type {
  DaemonLockPolicy,
  DaemonServerMode,
  DaemonTransportPreference,
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

/**
 * Who owns the daemon on a client's state directory.
 *
 * - `managed`: the client starts a missing daemon and replaces an incompatible one itself, and may
 *   retire a hung one after a timeout. This is the default until 0.22.
 * - `attach`: the client only connects to the daemon registered in the state directory. It never
 *   starts, replaces or kills one. A missing daemon fails with `details.reason: 'daemon-not-running'`
 *   and an incompatible one with `'daemon-incompatible'`; `ensureDaemon()` is the explicit way to
 *   start or replace one.
 *
 * Independent of `daemonTransport`, `daemonServerMode` and `daemonBaseUrl`: a remote connection
 * never starts or retires a local daemon in either mode.
 */
export type DaemonLifecycle = 'attach' | 'managed';

/** What a client can learn about a daemon without talking to it: how it identifies itself on disk. */
export type DaemonIdentity = {
  pid: number;
  version?: string;
  /** `installed` for a published package, `checkout` for a source tree. */
  codeOrigin?: 'installed' | 'checkout';
  codeSignature?: string;
  processStartTime?: string;
};

export type EnsureDaemonOptions = {
  /** The state directory the daemon owns; defaults to `AGENT_DEVICE_STATE_DIR`, then the user default. */
  stateDir?: string;
  daemonTransport?: DaemonTransportPreference;
  daemonServerMode?: DaemonServerMode;
  /**
   * Called when this call started a daemon, before `ensureDaemon` returns. `missing` means no
   * usable daemon was registered; `incompatible` means a daemon this client cannot use was
   * replaced after it agreed to leave. `previous` is the daemon that was replaced, when there was
   * one: a `missing` start with a `previous` replaced a registered daemon that answered nothing,
   * either unreachable or hung and force-retired.
   */
  onStart?: (reason: 'missing' | 'incompatible', previous?: DaemonIdentity) => void;
};

/** A reachable local daemon. It carries no credentials. */
export type DaemonConnection = {
  stateDir: string;
  daemon: DaemonIdentity;
  /** True when this call started the daemon. */
  started: boolean;
};

export type AgentDeviceDaemonTransportContext = {
  authToken?: string;
  /** How this request treats the local daemon; `managed` when omitted. */
  daemonLifecycle?: DaemonLifecycle;
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
    /** See `DaemonLifecycle`. */
    daemonLifecycle?: DaemonLifecycle;
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
  | 'providerDeviceType'
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
