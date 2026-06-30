import {
  ensureCompanionTunnel,
  stopCompanionTunnel,
  type CompanionTunnelDefinition,
  type EnsureCompanionTunnelResult,
} from './client-companion-tunnel.ts';
import {
  REACT_DEVTOOLS_COMPANION_RUN_ARG,
  type CompanionTunnelScope,
} from './client-companion-tunnel-contract.ts';

const REACT_DEVTOOLS_LOCAL_BASE_URL = 'http://127.0.0.1:8097';
const REACT_DEVTOOLS_DEVICE_PORT = 8097;
const REACT_DEVTOOLS_REGISTER_PATH = '/api/react-devtools/companion/register';
const REACT_DEVTOOLS_UNREGISTER_PATH = '/api/react-devtools/companion/unregister';

const REACT_DEVTOOLS_COMPANION_TUNNEL: CompanionTunnelDefinition = {
  slug: 'react-devtools-companion',
  runArg: REACT_DEVTOOLS_COMPANION_RUN_ARG,
  displayName: 'React DevTools companion',
};

export type EnsureReactDevtoolsCompanionOptions = {
  projectRoot: string;
  stateDir?: string;
  serverBaseUrl: string;
  bearerToken: string;
  bridgeScope: CompanionTunnelScope;
  session: string;
  profileKey?: string;
  consumerKey?: string;
  localBaseUrl?: string;
  devicePort?: number;
  env?: NodeJS.ProcessEnv;
};

export type StopReactDevtoolsCompanionOptions = {
  projectRoot: string;
  stateDir?: string;
  profileKey?: string;
  consumerKey?: string;
};

export async function ensureReactDevtoolsCompanion(
  options: EnsureReactDevtoolsCompanionOptions,
): Promise<EnsureCompanionTunnelResult> {
  return await ensureCompanionTunnel({
    ...options,
    definition: REACT_DEVTOOLS_COMPANION_TUNNEL,
    localBaseUrl: options.localBaseUrl ?? REACT_DEVTOOLS_LOCAL_BASE_URL,
    registerPath: REACT_DEVTOOLS_REGISTER_PATH,
    unregisterPath: REACT_DEVTOOLS_UNREGISTER_PATH,
    devicePort: options.devicePort ?? REACT_DEVTOOLS_DEVICE_PORT,
  });
}

export async function stopReactDevtoolsCompanion(
  options: StopReactDevtoolsCompanionOptions,
): Promise<{ stopped: boolean; statePath: string }> {
  return await stopCompanionTunnel({
    ...options,
    definition: REACT_DEVTOOLS_COMPANION_TUNNEL,
  });
}
