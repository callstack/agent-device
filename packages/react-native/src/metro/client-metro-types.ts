import type { MetroBridgeScope, ResolvedMetroKind } from '@agent-device/contracts/remote';
import type { MetroBridgeRuntimePayload } from './metro-types.ts';

/**
 * The shapes one Metro run carries between its prepare, spawn and reload steps. Types only:
 * nothing imports this module at runtime, so it adds no module to any import closure.
 */
export type EnvSource = NodeJS.ProcessEnv | Record<string, string | undefined>;

export type RepackBundlerKind = 'rspack' | 'webpack';

export type PackageManagerConfig = {
  command: string;
  installArgs: string[];
};

export type MetroProcessResult = {
  pid: number;
  /** The lifetime the host reported at spawn; a stale pid cannot imitate it. */
  startTime?: string;
};

export type ResolvedMetroPrepareSettings = {
  env: EnvSource;
  cwd: string;
  projectRoot: string;
  kind: ResolvedMetroKind;
  repackBundler: RepackBundlerKind | null;
  metroPort: number;
  listenHost: string;
  statusHost: string;
  publicBaseUrl: string;
  proxyBaseUrl: string;
  proxyBearerToken: string;
  bridgeScope: MetroBridgeScope | null;
  startupTimeoutMs: number;
  probeTimeoutMs: number;
  reuseExisting: boolean;
  installProjectDeps: boolean;
  runtimeFilePath: string | null;
  logPath: string;
};

export type MetroProcessState = {
  started: boolean;
  reused: boolean;
  pid: number;
  statusUrl: string;
};

export type ProxyBridgeRequestOptions = {
  baseUrl: string;
  bearerToken: string;
  scope: MetroBridgeScope;
  runtime?: MetroBridgeRuntimePayload;
  timeoutMs: number;
};

export type MetroBridgeRequestError = Error & {
  retryable?: boolean;
};
