import type { AgentDevicePlugin } from 'agent-device/plugins';
import { tvPluginConnection } from '@agent-device/tv-cdp/connection';

import { PROVIDER, type TizenOptions } from './provider.ts';

function tizen(options: TizenOptions = {}) {
  return {
    apiVersion: 2,
    provider: PROVIDER,
    credentials: { variables: [] },
    connection: tvPluginConnection({
      provider: PROVIDER,
      service: 'Samsung Tizen',
      verificationMessage: 'Tizen TVs are reached over sdb when a session opens.',
      defaultDevice: options.device,
    }),
    setup: async (host) => (await import('./runtime.ts')).createTizenRuntime(options, host),
  } satisfies AgentDevicePlugin;
}

export { tizen as default };
