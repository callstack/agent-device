export const METRO_COMPANION_RUN_ARG = '--agent-device-run-metro-companion';
export const REACT_DEVTOOLS_COMPANION_RUN_ARG = '--agent-device-run-react-devtools-companion';
export const COMPANION_TUNNEL_RECONNECT_DELAY_MS = 1_000;
export const COMPANION_TUNNEL_LEASE_CHECK_INTERVAL_MS = 250;
export const WS_READY_STATE_OPEN = 1;

export const ENV_COMPANION_TUNNEL_SERVER_BASE_URL = 'AGENT_DEVICE_COMPANION_TUNNEL_SERVER_BASE_URL';
export const ENV_COMPANION_TUNNEL_BEARER_TOKEN = 'AGENT_DEVICE_COMPANION_TUNNEL_BEARER_TOKEN';
export const ENV_COMPANION_TUNNEL_LOCAL_BASE_URL = 'AGENT_DEVICE_COMPANION_TUNNEL_LOCAL_BASE_URL';
export const ENV_COMPANION_TUNNEL_LAUNCH_URL = 'AGENT_DEVICE_COMPANION_TUNNEL_LAUNCH_URL';
export const ENV_COMPANION_TUNNEL_STATE_PATH = 'AGENT_DEVICE_COMPANION_TUNNEL_STATE_PATH';
export const ENV_COMPANION_TUNNEL_SCOPE_TENANT_ID = 'AGENT_DEVICE_COMPANION_TUNNEL_SCOPE_TENANT_ID';
export const ENV_COMPANION_TUNNEL_SCOPE_RUN_ID = 'AGENT_DEVICE_COMPANION_TUNNEL_SCOPE_RUN_ID';
export const ENV_COMPANION_TUNNEL_SCOPE_LEASE_ID = 'AGENT_DEVICE_COMPANION_TUNNEL_SCOPE_LEASE_ID';
export const ENV_COMPANION_TUNNEL_REGISTER_PATH = 'AGENT_DEVICE_COMPANION_TUNNEL_REGISTER_PATH';
export const ENV_COMPANION_TUNNEL_UNREGISTER_PATH = 'AGENT_DEVICE_COMPANION_TUNNEL_UNREGISTER_PATH';
export const ENV_COMPANION_TUNNEL_DEVICE_PORT = 'AGENT_DEVICE_COMPANION_TUNNEL_DEVICE_PORT';
export const ENV_COMPANION_TUNNEL_SESSION = 'AGENT_DEVICE_COMPANION_TUNNEL_SESSION';

export type CompanionTunnelScope = {
  tenantId: string;
  runId: string;
  leaseId: string;
};

export type MetroBridgeScope = CompanionTunnelScope;

export class MissingCompanionEnvError extends Error {
  override name = 'MissingCompanionEnvError';
}

export type CompanionTunnelWorkerOptions = {
  serverBaseUrl: string;
  bearerToken: string;
  localBaseUrl: string;
  bridgeScope: CompanionTunnelScope;
  registerPath: string;
  launchUrl?: string;
  statePath?: string;
  unregisterPath?: string;
  devicePort?: number;
  session?: string;
};
