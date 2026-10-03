import type { AgentDeviceClient } from '../../agent-device-client.ts';
import type { CliFlags } from '@agent-device/contracts/command';

export const TAKEOVER_CLI_FLAGS: CliFlags = { json: true, help: false, version: false };

export function createStubClientLeases(): AgentDeviceClient['leases'] {
  return {
    allocate: async (options) => ({
      leaseId: 'lease-1',
      tenantId: options.tenant,
      runId: options.runId,
      backend: options.leaseBackend ?? 'ios-simulator',
    }),
    heartbeat: async (options) => ({
      leaseId: options.leaseId,
      tenantId: options.tenant ?? 'tenant',
      runId: options.runId ?? 'run',
      backend: options.leaseBackend ?? 'ios-simulator',
    }),
    release: async () => ({ released: true }),
    humanControl: {
      list: async () => [],
      put: async () => {
        throw new Error('Unexpected takeover in this fixture');
      },
      remove: async () => false,
    },
  };
}
