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

export type ReloadMetroResult = {
  reloaded: true;
  reloadUrl: string;
  status: number;
  body: string;
  transport: 'http' | 'message-socket';
};
