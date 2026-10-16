import {
  ensureCompanionTunnel,
  stopCompanionTunnel,
  type CompanionTunnelDefinition,
  type EnsureCompanionTunnelOptions,
  type StopCompanionTunnelOptions,
} from './client-companion-tunnel.ts';
import { METRO_COMPANION_RUN_ARG } from './client-companion-tunnel-contract.ts';

const METRO_COMPANION_REGISTER_PATH = '/api/metro/companion/register';

const METRO_COMPANION_TUNNEL: CompanionTunnelDefinition = {
  slug: 'metro-companion',
  runArg: METRO_COMPANION_RUN_ARG,
  displayName: 'Metro companion',
};

export async function ensureMetroCompanion(
  options: Omit<EnsureCompanionTunnelOptions, 'definition'>,
) {
  return await ensureCompanionTunnel({
    ...options,
    definition: METRO_COMPANION_TUNNEL,
    registerPath: options.registerPath ?? METRO_COMPANION_REGISTER_PATH,
  });
}

export async function stopMetroCompanion(
  options: Omit<StopCompanionTunnelOptions, 'definition'>,
): Promise<{ stopped: boolean; statePath: string }> {
  return await stopCompanionTunnel({
    ...options,
    definition: METRO_COMPANION_TUNNEL,
  });
}
