import type {
  NetworkTransport,
  NetworkTransportScope,
} from '@agent-device/contracts/network-runtime';
import { NETWORK_MAX_PAYLOAD_CHARS } from '@agent-device/contracts/network-runtime';
import type { DeviceInfo } from '@agent-device/kernel/device';
import type { HostEnvironment } from '@agent-device/kernel/source-value';

/**
 * The session's React Native app runtime as a network transport. The gate is the session's own
 * Metro binding: only a session opened with a dev-server runtime has an in-app capture to read,
 * so a plain device session is never probed. What the capture itself reports — an unreachable dev
 * server, several connected apps — reaches the dump as a typed note, not a transport failure.
 */
export async function resolveReactNativeNetworkTransport(
  device: DeviceInfo,
  scope: NetworkTransportScope,
  host: HostEnvironment,
): Promise<NetworkTransport> {
  if (device.platform !== 'apple' && device.platform !== 'android') {
    return Object.freeze({ mode: 'local' });
  }
  if (scope.stateDir === undefined) return Object.freeze({ mode: 'local' });
  const { readMetroSessionRuntime, dumpReactNativeAppNetwork } =
    await import('@agent-device/react-native');
  const runtime = await readMetroSessionRuntime({
    stateDir: scope.stateDir,
    session: scope.sessionId,
    host,
  });
  if (runtime === undefined) return Object.freeze({ mode: 'local' });
  const stateDir = scope.stateDir;
  const maxPayloadChars = scope.maxPayloadChars ?? NETWORK_MAX_PAYLOAD_CHARS;
  return Object.freeze({
    mode: 'local',
    dump: async (input, signal) => {
      // The identity probe is the first thing the dump pays for: only a session that reached this
      // point (a Metro binding exists) runs the platform's adb or simctl probe, and the dump's own
      // budget signal bounds it.
      const metroDeviceIdentity = await scope.resolveMetroDeviceIdentity?.(
        signal ?? AbortSignal.timeout(30_000),
      );
      return await dumpReactNativeAppNetwork(
        {
          stateDir,
          session: scope.sessionId,
          ...(scope.appBundleId === undefined ? {} : { appBundleId: scope.appBundleId }),
          maxEntries: input.maxEntries,
          include: input.include,
          maxPayloadChars,
          ...(metroDeviceIdentity === undefined ? {} : { metroDeviceIdentity }),
        },
        signal,
      );
    },
  });
}
