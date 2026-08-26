import type { DeviceInfo } from '@agent-device/kernel/device';
import { resolveIosPhysicalDeviceControl } from './host.ts';

const RUNNER_DEVICE_TUNNEL_IP_CACHE_TTL_MS = 30_000;

type DeviceTunnelIpCacheEntry = {
  ip: string;
  expiresAt: number;
};

export type RunnerCommandRoute =
  | {
      kind: 'network';
      endpoints: string[];
      cachedTunnelIp: boolean;
    }
  | {
      kind: 'usbmux';
      endpoints: [string];
      cachedTunnelIp: false;
    };

const deviceTunnelIpCache = new Map<string, DeviceTunnelIpCacheEntry>();

/**
 * Physical iOS devices are reached through usbmux whenever they are attached by
 * cable (#1403): usbmuxd answers in milliseconds and the connection stays
 * usable across idle gaps, where the CoreDevice tunnel route re-probes
 * `devicectl` — seconds per command once its short-lived cache expires.
 *
 * A CoreDevice-backed device that usbmuxd does not list is Wi-Fi-only (modern
 * CoreDevice Wi-Fi runs over `remoted`, which usbmuxd never sees), so it falls
 * back to the tunnel route. The tunnel lookup and its cache therefore only run
 * for devices that genuinely need them, and cabled devices never pay for them.
 */
export function createRunnerCommandRouteResolver(device: DeviceInfo, port: number) {
  let requestTunnelIp: string | null | undefined;
  let usbmuxUnattached = false;
  return {
    /**
     * Records that usbmux cannot reach this device, so the remaining resolves
     * in this request go straight to the CoreDevice tunnel route.
     */
    markUsbmuxUnattached: (): void => {
      usbmuxUnattached = true;
    },
    resolveRoute: async (
      timeoutBudgetMs?: number,
      forceRefresh = false,
    ): Promise<RunnerCommandRoute> => {
      if (device.kind !== 'device') {
        return buildNetworkRoute(device, port, null, false);
      }
      const control = resolveIosPhysicalDeviceControl(device);
      if (control.backend === 'xctest') return buildUsbmuxRoute(device, port);
      if (!usbmuxUnattached) return buildUsbmuxRoute(device, port);
      if (!forceRefresh) {
        const cached = readDeviceTunnelIpCache(device.id);
        if (cached) return buildNetworkRoute(device, port, cached, true);
        if (requestTunnelIp !== undefined) {
          return buildNetworkRoute(device, port, requestTunnelIp, false);
        }
      }
      const { tunnelIp } = await control.resolveTunnel(device, timeoutBudgetMs);
      requestTunnelIp = tunnelIp;
      if (tunnelIp) writeDeviceTunnelIpCache(device.id, tunnelIp);
      return buildNetworkRoute(device, port, tunnelIp, false);
    },
  };
}

export function invalidateDeviceTunnelIpCache(deviceId: string): void {
  deviceTunnelIpCache.delete(deviceId);
}

/**
 * @internal Test isolation hook for the process-global device tunnel IP cache.
 */
export function clearDeviceTunnelIpCache(): void {
  deviceTunnelIpCache.clear();
}

function buildUsbmuxRoute(device: DeviceInfo, port: number): RunnerCommandRoute {
  return {
    kind: 'usbmux',
    endpoints: [`usbmux://${device.id}:${port}/command`],
    cachedTunnelIp: false,
  };
}

function buildNetworkRoute(
  device: DeviceInfo,
  port: number,
  tunnelIp: string | null,
  cachedTunnelIp: boolean,
): RunnerCommandRoute {
  const endpoints = [`http://127.0.0.1:${port}/command`];
  if (device.kind === 'device' && tunnelIp) {
    endpoints.unshift(`http://[${tunnelIp}]:${port}/command`);
  }
  return { kind: 'network', endpoints, cachedTunnelIp };
}

function readDeviceTunnelIpCache(deviceId: string): string | null {
  const cached = deviceTunnelIpCache.get(deviceId);
  if (!cached) return null;
  if (cached.expiresAt <= Date.now()) {
    deviceTunnelIpCache.delete(deviceId);
    return null;
  }
  return cached.ip;
}

function writeDeviceTunnelIpCache(deviceId: string, ip: string): void {
  deviceTunnelIpCache.set(deviceId, {
    ip,
    expiresAt: Date.now() + RUNNER_DEVICE_TUNNEL_IP_CACHE_TTL_MS,
  });
}
