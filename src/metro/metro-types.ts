import type { SessionRuntimeHints } from '../kernel/contracts.ts';

/** Re-export of {@link SessionRuntimeHints} under the Metro-specific alias used by public API consumers. */
export type MetroRuntimeHints = SessionRuntimeHints;

// The bridge RESULT shape is declared in contracts/metro.ts, because the public prepare result
// embeds it and that shape had to move below both `metro/` and the command surface.
export type { MetroBridgeResult } from '../contracts/metro.ts';

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
