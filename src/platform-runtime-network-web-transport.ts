import type { NetworkTransport } from '@agent-device/contracts/network-runtime';
import type { DeviceInfo } from '@agent-device/kernel/device';

export async function resolveWebNetworkTransport(device: DeviceInfo): Promise<NetworkTransport> {
  if (device.platform !== 'web') return Object.freeze({ mode: 'local' });
  const { hasScopedWebProvider, resolveWebProvider } = await import('@agent-device/platform-web');
  const provider = await resolveWebProvider();
  const dumpNetwork = provider.dumpNetwork;
  const mode = (await hasScopedWebProvider()) ? 'transport-composed' : 'local';
  if (!dumpNetwork) return Object.freeze({ mode });
  return Object.freeze({
    mode,
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
