import type { WebPlatformSelection } from '@agent-device/contracts/platform-plugin';
import type { NetworkTransport } from '@agent-device/contracts/network-runtime';
import type { DeviceInfo } from '@agent-device/kernel/device';

export async function resolveWebNetworkTransport(
  device: DeviceInfo,
  web?: WebPlatformSelection,
): Promise<NetworkTransport> {
  if (device.platform !== 'web') return Object.freeze({ mode: 'local' });
  const provider = await web?.get().operations.resolveRequestProvider();
  if (!provider) return Object.freeze({ mode: 'local' });
  const dumpNetwork = provider.dumpNetwork;
  if (!dumpNetwork) return Object.freeze({ mode: 'transport-composed' });
  return Object.freeze({
    mode: 'transport-composed',
    dump: async (input) => {
      const result = await dumpNetwork({ limit: input.maxEntries, include: input.include });
      return Object.freeze({
        backend: result.backend ?? 'agent-browser',
        entries: result.entries,
        ...(result.notes === undefined ? {} : { notes: result.notes }),
      });
    },
  });
}
