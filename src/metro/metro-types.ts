import type { SessionRuntimeHints } from '../contracts.ts';

/** Re-export of {@link SessionRuntimeHints} under the Metro-specific alias used by public API consumers. */
export type MetroRuntimeHints = SessionRuntimeHints;

export type MetroBridgeResult = {
  enabled: boolean;
  baseUrl: string;
  statusUrl: string;
  bundleUrl: string;
  iosRuntime: MetroRuntimeHints;
  androidRuntime: MetroRuntimeHints;
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

export type MetroBridgeRuntimePayload = {
  metro_host?: string;
  metro_port?: number;
  metro_bundle_url?: string;
  launch_url?: string;
};

export type MetroBridgeDescriptor = {
  enabled: boolean;
  base_url: string;
  status_url?: string;
  bundle_url?: string;
  ios_runtime: MetroBridgeRuntimePayload;
  android_runtime: MetroBridgeRuntimePayload;
  upstream: {
    bundle_url?: string;
    host?: string;
    port?: number;
    status_url?: string;
  };
  probe: {
    reachable: boolean;
    status_code: number;
    latency_ms: number;
    detail: string;
  };
};
