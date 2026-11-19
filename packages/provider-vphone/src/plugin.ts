// fallow-ignore-file unused-file
import type { ProviderPluginHost } from 'agent-device/plugins';
import { createVphoneConnection, vphoneTransportOptions } from './connection.ts';
import { createVphoneRuntime } from './runtime.ts';
import type { VphoneOptions } from './index.ts';

export default function vphonePlugin(host: ProviderPluginHost, options: VphoneOptions = {}) {
  const resolved = vphoneTransportOptions(host, options);
  return {
    ...createVphoneRuntime(resolved),
    connection: createVphoneConnection(resolved),
  };
}
