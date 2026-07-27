import type { MetroBridgeScope } from './companion-tunnel-scope.ts';
import type { SessionRuntimeHints } from '../kernel/contracts.ts';

// Metro vocabulary shared by the command surface (which validates it) and metro/ (which
// acts on it).

export type MetroPrepareKind = 'auto' | 'react-native' | 'expo' | 'repack';

/** A prepare kind after resolution: `auto` is a request, never an outcome. */
export type ResolvedMetroKind = Exclude<MetroPrepareKind, 'auto'>;

export type MetroBridgeResult = {
  enabled: boolean;
  baseUrl: string;
  statusUrl: string;
  bundleUrl: string;
  iosRuntime: SessionRuntimeHints;
  androidRuntime: SessionRuntimeHints;
  upstream: {
    bundleUrl: string;
    host: string;
    port: number;
    statusUrl: string;
  };
  probe: {
    reachable: boolean;
    statusCode: number;
    latencyMs: number;
    detail: string;
  };
};

export type PrepareMetroRuntimeResult = {
  projectRoot: string;
  kind: ResolvedMetroKind;
  dependenciesInstalled: boolean;
  packageManager: string | null;
  started: boolean;
  reused: boolean;
  pid: number;
  logPath: string;
  statusUrl: string;
  runtimeFilePath: string | null;
  iosRuntime: SessionRuntimeHints;
  androidRuntime: SessionRuntimeHints;
  bridge: MetroBridgeResult | null;
};

/**
 * `transport` says which channel delivered the reload: `http` for the classic GET /reload route,
 * `message-socket` for the /message websocket broadcast used when the server has no HTTP reload
 * route (Expo). `status`/`body` always describe the HTTP probe; on the websocket path `reloadUrl`
 * is the ws(s) message-socket URL.
 */
export type ReloadMetroResult = {
  reloaded: true;
  reloadUrl: string;
  status: number;
  body: string;
  transport: 'http' | 'message-socket';
};

// The client-facing Metro command vocabulary lives here rather than in a contracts/client-*.ts
// family file, so that one file answers the Metro question.
export type MetroPrepareOptions = {
  projectRoot?: string;
  kind?: MetroPrepareKind;
  publicBaseUrl?: string;
  proxyBaseUrl?: string;
  bearerToken?: string;
  bridgeScope?: MetroBridgeScope;
  launchUrl?: string;
  companionProfileKey?: string;
  companionConsumerKey?: string;
  port?: number;
  listenHost?: string;
  statusHost?: string;
  startupTimeoutMs?: number;
  probeTimeoutMs?: number;
  reuseExisting?: boolean;
  installDependenciesIfNeeded?: boolean;
  runtimeFilePath?: string;
  logPath?: string;
};

export type MetroReloadOptions = {
  metroHost?: string;
  metroPort?: number;
  bundleUrl?: string;
  timeoutMs?: number;
};

export type MetroPrepareResult = PrepareMetroRuntimeResult;

export type MetroReloadResult = ReloadMetroResult;
