import type { SessionRuntimeHints } from '@agent-device/kernel/contracts';
import { resolveRuntimeTransportHints } from '@agent-device/host-kit/runtime-transport-hints';
import type { PrepareMetroRuntimeOptions, ReloadMetroOptions } from './client-metro.ts';
import type { StopMetroTunnelOptions } from './metro.ts';

export { normalizeBaseUrl } from './base-url.ts';
export { buildBundleUrl } from './bundle-url.ts';
export type {
  MetroBridgeDescriptor,
  MetroTunnelRequestMessage,
  MetroTunnelResponseMessage,
} from './metro.ts';

export function resolveRuntimeTransport(
  runtime: SessionRuntimeHints | undefined,
): { host: string; port: number; scheme: 'http' | 'https' } | undefined {
  return resolveRuntimeTransportHints(runtime);
}

export async function prepareMetroRuntime(input: PrepareMetroRuntimeOptions = {}) {
  const runtime = await import('./client-metro.ts');
  return await runtime.prepareMetroRuntime(input);
}

export async function reloadMetro(input: ReloadMetroOptions = {}) {
  const runtime = await import('./client-metro.ts');
  return await runtime.reloadMetro(input);
}

export async function stopMetroTunnel(options: StopMetroTunnelOptions): Promise<void> {
  const runtime = await import('./metro.ts');
  await runtime.stopMetroTunnel(options);
}
