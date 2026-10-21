import type {
  AppDeviceResolver,
  ComposedDeviceInventoryGateways,
  InstalledAppProbe,
  InventoryPlatformModule,
  PlatformModuleRegistry,
} from '@agent-device/contracts/platform-module';
import type { DeviceInventoryHost } from '@agent-device/contracts/platform-runtime-host';
import type { ProviderDeviceInventorySource } from '@agent-device/contracts/device';
import { hostAppDevice, isMacOs } from '@agent-device/kernel/device';
import type { EnvMap } from '@agent-device/kernel/source-value';

// Composes the package-level gateways and attaches the Apple selection probes this host owns.
export async function attachAppleSelectionProbes(
  options: Readonly<{
    registry: PlatformModuleRegistry<InventoryPlatformModule>;
    loadHost: () => Promise<DeviceInventoryHost>;
    provider?: ProviderDeviceInventorySource;
    env: Readonly<EnvMap>;
  }>,
): Promise<ComposedDeviceInventoryGateways> {
  // Function-scoped: the composition root's eager closure is the hub every daemon start and CLI
  // run pays for, so the package composer is evaluated only when an inventory composition runs.
  const { createComposedDeviceInventoryGateways: compose } =
    await import('@agent-device/device-selection/composed-inventory-gateways');
  const { env, ...gateways } = options;
  return compose({
    ...gateways,
    findInstalledApp: appleInstalledAppProbe,
    resolveAppDevice: macOsAppDeviceResolver(env),
  });
}

// Function-scoped: device selection reads this probe from the request context, and loading it
// must not evaluate Apple app-resolution mechanics until a selection actually narrows.
const appleInstalledAppProbe: InstalledAppProbe = async (device, appTarget) => {
  const { findIosSimulatorInstalledApp } =
    await import('@agent-device/platform-apple/app-resolution');
  return await findIosSimulatorInstalledApp(device, appTarget);
};

/**
 * A native macOS app session drives its app alone, so the app is a device of its own (ADR 0035)
 * and sessions on different apps run side by side. The XCTest backend posts screen events outside
 * the app, so its sessions keep the whole Mac.
 */
function macOsAppDeviceResolver(env: Readonly<EnvMap>): AppDeviceResolver {
  return async (host, appTarget) => {
    if (!isMacOs(host) || host.hostApp) return undefined;
    // Function-scoped, like the probes above: selection pays for the backend read only on a Mac.
    const { readMacOsAppBackend } = await import('@agent-device/contracts/session');
    if (readMacOsAppBackend((name) => env[name]) !== 'native') return undefined;
    const { resolveIosApp } = await import('@agent-device/platform-apple/app-resolution');
    return hostAppDevice(host, await resolveIosApp(host, appTarget));
  };
}
