import type {
  MetroSessionOptions,
  MetroSessionOpenInput,
  MetroSessionScope,
} from './metro/metro-session-hints.ts';
import type { MetroReloadTargetInput } from './metro/metro-reload-endpoints.ts';
import type { SessionRuntimeHints } from '@agent-device/kernel/contracts';
import type { HostEnvironment } from '@agent-device/kernel/source-value';
import { resolveRuntimeTransportHints } from '@agent-device/host-kit/runtime-transport-hints';
import type { PrepareMetroRuntimeOptions, ReloadMetroOptions } from './metro/client-metro.ts';
import type { PrepareMetroRuntimeResult, ReloadMetroResult } from '@agent-device/contracts/remote';

export type { PrepareMetroRuntimeOptions, ReloadMetroOptions } from './metro/client-metro.ts';
export type { PrepareMetroRuntimeResult, ReloadMetroResult } from '@agent-device/contracts/remote';
export type { MetroBridgeDescriptor } from './metro/metro-types.ts';
export type { MetroSessionOptions, MetroSessionOpenInput } from './metro/metro-session-hints.ts';

export type StopMetroTunnelOptions = {
  projectRoot: string;
  profileKey?: string;
  consumerKey?: string;
};

export { normalizeBaseUrl } from './metro/base-url.ts';
export { buildBundleUrl } from './metro/bundle-url.ts';
export type {
  MetroTunnelRequestMessage,
  MetroTunnelResponseMessage,
} from './companion/metro-tunnel-messages.ts';

export function resolveRuntimeTransport(
  runtime: SessionRuntimeHints | undefined,
): { host: string; port: number; scheme: 'http' | 'https' } | undefined {
  return resolveRuntimeTransportHints(runtime);
}

export async function prepareMetroRuntime(
  input: PrepareMetroRuntimeOptions,
  host: HostEnvironment,
): Promise<PrepareMetroRuntimeResult> {
  const runtime = await import('./metro/client-metro.ts');
  return await runtime.prepareMetroRuntime(input, host);
}

export async function reloadMetro(input: ReloadMetroOptions = {}): Promise<ReloadMetroResult> {
  const runtime = await import('./metro/client-metro.ts');
  return await runtime.reloadMetro(input);
}

export async function resolveSessionMetroServerUrl(
  scope: MetroSessionScope,
  input: MetroReloadTargetInput,
): Promise<URL> {
  const session = await import('./metro/metro-session-hints.ts');
  return session.resolveSessionMetroServerUrl(scope, input);
}

export async function stopMetroTunnel(options: StopMetroTunnelOptions): Promise<void> {
  const { stopMetroCompanion } = await import('./companion/client-metro-companion.ts');
  await stopMetroCompanion(options);
}

export async function recordPreparedMetroSession(
  options: MetroSessionOptions,
  result: Pick<PrepareMetroRuntimeResult, 'statusUrl' | 'iosRuntime' | 'androidRuntime'>,
): Promise<void> {
  const session = await import('./metro/metro-session-hints.ts');
  session.recordPreparedMetroSession(options, result);
}

export async function recordOpenedMetroSession(
  options: MetroSessionOptions,
  input: MetroSessionOpenInput,
): Promise<void> {
  const session = await import('./metro/metro-session-hints.ts');
  session.recordOpenedMetroSession(options, input);
}

export async function readMetroSessionRuntime(
  options: MetroSessionOptions,
): Promise<SessionRuntimeHints | undefined> {
  const session = await import('./metro/metro-session-hints.ts');
  return session.readMetroSessionRuntime(options);
}

export async function clearMetroSessionHintsQuietly(options: MetroSessionOptions): Promise<void> {
  const session = await import('./metro/metro-session-hints.ts');
  session.clearMetroSessionHintsQuietly(options);
}
