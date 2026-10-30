import type { AgentDevicePlugin } from 'agent-device/plugins';
import { tvPluginConnection } from '@agent-device/tv-cdp/connection';

import { PROVIDER, type WebosOptions } from './provider.ts';

function webos(options: WebosOptions = {}) {
  return {
    apiVersion: 2,
    provider: PROVIDER,
    credentials: { variables: [] },
    connection: tvPluginConnection({
      provider: PROVIDER,
      service: 'LG webOS',
      verificationMessage: 'webOS TVs are read from ares-setup-device when a session opens.',
      defaultDevice: options.device,
    }),
    setup: async (host) => (await import('./runtime.ts')).createWebosRuntime(options, host),
  } satisfies AgentDevicePlugin;
}

export { webos as default };
