import type { DeviceInfo } from '@agent-device/kernel/device';
import { resolveIosPhysicalDeviceControl } from '../physical-device-control.ts';

const RUNNER_DEVICE_TUNNEL_IP_CACHE_TTL_MS = 30_000;

/**
 * Experimental override for #1403: forces physical-device runner commands
 * through usbmux regardless of backend. Daemon-scoped: the value is re-read
 * on every resolve, but from the daemon's environment, which is captured at
 * daemon launch — a later CLI invocation cannot change it. Use a fresh
 * isolated state-dir/daemon per experiment route leg.
 */
const RUNNER_ROUTE_OVERRIDE_ENV = 'AGENT_DEVICE_IOS_RUNNER_ROUTE';

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

export function createRunnerCommandRouteResolver(device: DeviceInfo, port: number) {
  let requestTunnelIp: string | null | undefined;
  return {
    resolveRoute: async (
      timeoutBudgetMs?: number,
      forceRefresh = false,
    ): Promise<RunnerCommandRoute> => {
      if (device.kind !== 'device') {
        return buildNetworkRoute(device, port, null, false);
      }
      const control = resolveIosPhysicalDeviceControl(device);
      if (control.backend === 'xctest' || readRunnerRouteOverride() === 'usbmux') {
        return buildUsbmuxRoute(device, port);
      }
      if (!forceRefresh) {
        const cached = readDeviceTunnelIpCache(device.id);
        if (cached) return buildNetworkRoute(device, port, cached, true);
        if (requestTunnelIp !== undefined) {
          return buildNetworkRoute(device, port, requestTunnelIp, false);
        }
      }
      const transport = await control.resolveRunnerTransport(device, timeoutBudgetMs);
      if (transport.kind === 'usbmux') {
        return buildUsbmuxRoute(device, port);
      }
      const tunnelIp = transport.tunnelIp;
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

function readRunnerRouteOverride(): 'usbmux' | null {
  return process.env[RUNNER_ROUTE_OVERRIDE_ENV]?.trim() === 'usbmux' ? 'usbmux' : null;
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
