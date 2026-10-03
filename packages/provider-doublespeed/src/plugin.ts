import type { ProviderPluginHost } from 'agent-device/plugins';
import { verifyDoublespeedConnection } from './connection-verification.ts';
import type { CliFlags } from '@agent-device/contracts/command';

export default async function doublespeedPlugin(host: ProviderPluginHost) {
  const { createDoublespeedRuntime } = await import('./runtime.ts');
  const apiKey = host.env.DOUBLESPEED_API_KEY?.trim() ?? '';
  const registration = createDoublespeedRuntime(
    {
      apiKey,
      apiUrl: host.env.DOUBLESPEED_API_URL?.trim() || undefined,
      device: host.env.DOUBLESPEED_DEVICE?.trim() || undefined,
    },
    { clientVersion: host.clientVersion, host: host.apple, ios: host.apple },
    { includePlatformModule: true },
  );
  return {
    ...registration,
    connection: {
      resolve: ({ flags }: { flags: CliFlags }) => {
        if (!apiKey)
          throw host.createError(
            'INVALID_ARGS',
            'connect doublespeed requires DOUBLESPEED_API_KEY.',
          );
        if (flags.platform !== undefined && flags.platform !== 'ios')
          throw host.createError(
            'INVALID_ARGS',
            'connect doublespeed supports --platform ios only.',
          );
        if (flags.device !== undefined)
          throw host.createError(
            'INVALID_ARGS',
            'connect doublespeed does not accept --device; set DOUBLESPEED_DEVICE to pick the simulator model.',
          );
        if (flags.leaseBackend !== undefined && flags.leaseBackend !== 'ios-instance')
          throw host.createError(
            'INVALID_ARGS',
            'connect doublespeed requires --lease-backend ios-instance.',
          );
        return {
          profile: {
            leaseProvider: 'doublespeed',
            leaseBackend: 'ios-instance',
            platform: 'ios',
            daemonTransport: 'auto',
          } as const,
        };
      },
      verify: async () =>
        await verifyDoublespeedConnection({
          apiKey,
          apiUrl: host.env.DOUBLESPEED_API_URL?.trim() || undefined,
          clientVersion: host.clientVersion,
        }),
    },
  };
}
