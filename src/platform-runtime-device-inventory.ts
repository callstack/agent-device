import type {
  ComposedDeviceInventoryGateways,
  InstalledAppProbe,
  InventoryPlatformModule,
  PlatformModuleRegistry,
} from '@agent-device/contracts/platform-module';
import type { DeviceInventoryHost } from '@agent-device/contracts/platform-runtime-host';
import type { ProviderDeviceInventorySource } from '@agent-device/contracts/device';

// The composition flow lives in @agent-device/device-selection/composed-inventory-gateways, so
// the test fake there builds on the real one. This module is the production wiring: it attaches
// the Apple simulator app probe the host owns.

export function createComposedDeviceInventoryGateways(
  options: Readonly<{
    registry: PlatformModuleRegistry<InventoryPlatformModule>;
    loadHost: () => Promise<DeviceInventoryHost>;
    provider?: ProviderDeviceInventorySource;
  }>,
): Promise<ComposedDeviceInventoryGateways> {
  // Function-scoped: the composition root's eager closure is the hub every daemon start and CLI
  // run pays for, so the package composer is evaluated only when an inventory composition runs.
  return import('@agent-device/device-selection/composed-inventory-gateways').then(
    ({ createComposedDeviceInventoryGateways: compose }) =>
      compose({ ...options, findInstalledApp: appleInstalledAppProbe }),
  );
}

// Function-scoped: device selection reads this probe from the request context, and loading it
// must not evaluate Apple app-resolution mechanics until a selection actually narrows.
const appleInstalledAppProbe: InstalledAppProbe = async (device, appTarget) => {
  const { findIosSimulatorInstalledApp } =
    await import('@agent-device/platform-apple/app-resolution');
  return await findIosSimulatorInstalledApp(device, appTarget);
};
