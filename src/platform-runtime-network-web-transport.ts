import type { NetworkTransport } from '@agent-device/contracts/network-runtime';
import type { DeviceInfo } from '@agent-device/kernel/device';

export async function resolveWebNetworkTransport(device: DeviceInfo): Promise<NetworkTransport> {
  if (device.platform !== 'web') return Object.freeze({ mode: 'local' });
  const { hasScopedWebProvider, resolveWebProvider } = await import('@agent-device/platform-web');
  // Only the request's own provider answers: an unscoped one would read the default browser
  // session instead of the session's.
  if (!(await hasScopedWebProvider())) return Object.freeze({ mode: 'local' });
  const dumpNetwork = (await resolveWebProvider()).dumpNetwork;
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
