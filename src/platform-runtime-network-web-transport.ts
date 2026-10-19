import type { NetworkTransport } from '@agent-device/contracts/network-runtime';
import type { DeviceInfo } from '@agent-device/kernel/device';
import type { HostEnvironment } from '@agent-device/kernel/source-value';

export async function resolveWebNetworkTransport(
  device: DeviceInfo,
  host: HostEnvironment,
): Promise<NetworkTransport> {
  if (device.platform !== 'web') return Object.freeze({ mode: 'local' });
  const { hasScopedWebProvider, resolveWebProviderForHost } =
    await import('@agent-device/platform-web');
  // Every reader of one web request resolves the same provider through the one policy (#3794).
  const scoped = await hasScopedWebProvider();
  const provider = await resolveWebProviderForHost(host);
  const dumpNetwork = provider.dumpNetwork;
  const mode = scoped ? 'transport-composed' : 'local';
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
