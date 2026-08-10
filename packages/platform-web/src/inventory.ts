import { WEB_DESKTOP_DEVICE } from '@agent-device/contracts/device';
import type { DeviceInventorySource } from '@agent-device/contracts/platform';

export function createWebInventory(): DeviceInventorySource {
  return {
    discover: async () => {
      return [WEB_DESKTOP_DEVICE];
    },
  };
}
