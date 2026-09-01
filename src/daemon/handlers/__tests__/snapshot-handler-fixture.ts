import path from 'node:path';
import { mkdtempForTestSync } from '../../../__tests__/test-utils/tmp-dir.ts';
import type { ProviderDeviceRuntime } from '@agent-device/contracts/device';
import { SessionStore } from '../../session-store.ts';
import type { SessionState } from '../../types.ts';

export function makeSessionStore(): SessionStore {
  const root = mkdtempForTestSync('agent-device-snapshot-handler-');
  return new SessionStore(path.join(root, 'sessions'));
}

export function makeSession(
  name: string,
  device: SessionState['device'],
  extra?: Partial<SessionState>,
): SessionState {
  return { name, device, createdAt: Date.now(), actions: [], ...extra };
}

export function makeProviderRuntimeOwning(
  device: SessionState['device'],
  provider = 'browserstack',
): ProviderDeviceRuntime {
  return {
    provider,
    leaseLifecycle: {},
    deviceInventoryProvider: async () => [device],
    ownsDevice: (candidate) => candidate.id === device.id,
    getInteractor: () => undefined,
    shutdown: async () => undefined,
  };
}
