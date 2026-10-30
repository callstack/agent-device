import type { TvRuntimeHost } from './runtime.ts';
import type { TvPlatform } from './tv.ts';

export { listTargets, type CdpTarget } from './cdp.ts';
export { NAVIGATION_KEYS, type RemoteKeys } from './keys.ts';
export type { TvRuntimeHost } from './runtime.ts';
export type { PageTunnel, TvConnection } from './tv.ts';

// The runtime pulls in most of capture-kit, so it loads on first use to keep this entry light.
export async function createTvRuntime(platform: TvPlatform, host: TvRuntimeHost) {
  return (await import('./runtime.ts')).createTvRuntime(platform, host);
}
