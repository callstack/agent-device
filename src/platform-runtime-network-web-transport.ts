import type { NetworkTransport } from '@agent-device/contracts/network-runtime';
import type { DeviceInfo } from '@agent-device/kernel/device';

export async function resolveWebNetworkTransport(device: DeviceInfo): Promise<NetworkTransport> {
  if (device.platform !== 'web') return Object.freeze({ mode: 'local' });
  const { resolveRequestScopedWebProvider } = await import('@agent-device/platform-web');
  const provider = await resolveRequestScopedWebProvider();
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
