import { createTvRuntime, type TvConnection, type TvRuntimeHost } from '@agent-device/tv-cdp';

import { createAres, type HostEnv } from './ares.ts';
import { WEBOS_REMOTE_KEYS } from './keys.ts';
import { PROVIDER, type WebosOptions } from './provider.ts';

type WebosRuntimeHost = TvRuntimeHost & Readonly<{ env: HostEnv }>;

export function createWebosRuntime(options: WebosOptions, host: WebosRuntimeHost) {
  const ares = createAres(options.aresBin, host.env);

  async function connectTv(flagDevice: string | undefined): Promise<TvConnection> {
    const requested = flagDevice ?? options.device;
    const available = await ares.listDevices();
    const device = requested
      ? available.find((candidate) => candidate.name === requested)
      : (available.find((candidate) => candidate.isDefault) ?? available[0]);
    if (!device) {
      throw host.createError(
        'DEVICE_NOT_FOUND',
        `No webOS TV ${requested ? `named ${requested} ` : ''}in ares-setup-device`,
        {
          available: available.map((candidate) => candidate.name),
          hint: 'Add the TV with ares-setup-device, or pass --device <name>.',
        },
      );
    }
    const tv = ares.forDevice(device.name);
    return {
      name: device.name,
      launch: async (appId, { relaunch }) => {
        if (relaunch) await tv.close(appId).catch(() => {});
        await tv.launch(appId);
        return await tv.inspect(appId);
      },
      close: tv.close,
      listApps: tv.listApps,
    };
  }

  return createTvRuntime(
    { provider: PROVIDER, label: 'webOS', remoteKeys: WEBOS_REMOTE_KEYS, connectTv },
    host,
  );
}
