import type { ManagedWebBackend } from '@agent-device/contracts/managed-web-backend';
import type { HostEnvironment } from '@agent-device/kernel/source-value';

/** Root composition for the managed browser host tool used by the CLI web command. */
export function createManagedWebBackend(host: HostEnvironment): ManagedWebBackend {
  return Object.freeze({
    setup: async (options) => {
      const { setupManagedAgentBrowser } = await import('@agent-device/platform-web');
      return await setupManagedAgentBrowser({ ...options, host });
    },
    doctor: async (options) => {
      const { doctorManagedAgentBrowser } = await import('@agent-device/platform-web');
      return await doctorManagedAgentBrowser({ ...options, host });
    },
  });
}
