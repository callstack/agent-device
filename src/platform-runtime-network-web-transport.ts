import type { NetworkTransport } from '@agent-device/contracts/platform';
import type { DeviceInfo } from '@agent-device/kernel/device';

export async function resolveWebNetworkTransport(device: DeviceInfo): Promise<NetworkTransport> {
  if (device.platform !== 'web') return Object.freeze({ mode: 'local' });
  const { hasScopedWebProvider, resolveWebProvider } = await import('./platforms/web/provider.ts');
  const provider = resolveWebProvider();
  const dumpNetwork = provider.dumpNetwork;
  const mode = hasScopedWebProvider() ? 'transport-composed' : 'local';
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
