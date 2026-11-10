import { createTvRuntime, type TvConnection, type TvRuntimeHost } from '@agent-device/tv-cdp';

import { TIZEN_REMOTE_KEYS } from './keys.ts';
import { PROVIDER, type TizenOptions } from './provider.ts';
import { createSdb, sdbSerial } from './sdb.ts';
import { locateSdb, type HostEnv } from './tools.ts';

type TizenRuntimeHost = TvRuntimeHost & Readonly<{ env: HostEnv }>;

async function readySerials(sdb: ReturnType<typeof createSdb>) {
  return (await sdb.listDevices())
    .filter((device) => device.state === 'device')
    .map((device) => device.serial);
}

export function createTizenRuntime(options: TizenOptions, host: TizenRuntimeHost) {
  const sdb = createSdb(() => locateSdb(options.sdbPath, host.env), host.env);

  async function resolveSerial(requested: string | undefined) {
    const connected = await readySerials(sdb);
    if (!requested) {
      if (connected.length === 1) return connected[0]!;
      throw host.createError(
        'DEVICE_NOT_FOUND',
        connected.length === 0
          ? 'No Tizen TV is connected to sdb'
          : 'More than one Tizen TV is connected to sdb',
        { available: connected, hint: 'Pass --device <TV IP or sdb serial>.' },
      );
    }
    const serial = sdbSerial(requested);
    if (connected.includes(serial)) return serial;
    await sdb.connect(serial);
    if ((await readySerials(sdb)).includes(serial)) return serial;
    throw host.createError('DEVICE_NOT_FOUND', `sdb could not connect to the Tizen TV ${serial}`, {
      available: connected,
      hint: 'Check that the TV is on and in Developer Mode with this host IP set as the developer IP.',
    });
  }

  async function connectTv(flagDevice: string | undefined): Promise<TvConnection> {
    const requested = flagDevice ?? options.device;
    const tv = sdb.forDevice(await resolveSerial(requested));
    return {
      id: tv.serial,
      name: requested ?? tv.serial,
      launch: async (appId, { signal }) => await tv.launch(appId, { signal }),
      close: (appId, options) => tv.kill(appId, options?.signal),
      listApps: (options) => tv.listApps(options?.signal),
    };
  }

  return createTvRuntime(
    { provider: PROVIDER, label: 'Tizen', remoteKeys: TIZEN_REMOTE_KEYS, connectTv },
    host,
  );
}
