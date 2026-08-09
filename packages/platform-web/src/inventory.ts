import { WEB_DESKTOP_DEVICE } from '@agent-device/contracts/device';
import type { DeviceInventoryHost, DeviceInventorySource } from '@agent-device/contracts/platform';

export function createWebInventory(_host: DeviceInventoryHost): DeviceInventorySource {
  return {
    discover: async () => {
      return [WEB_DESKTOP_DEVICE];
    },
  };
}
