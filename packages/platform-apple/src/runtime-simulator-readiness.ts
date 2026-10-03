import { withMethodScope } from '@agent-device/kernel/scoped-provider';
import { resolveManagedDeviceReadiness } from '@agent-device/provision-kit/managed-device-scope';
import { withSimulatorReadiness } from './core/simulator.ts';

export function bindSimulatorReadiness<T extends object>(operations: T): Readonly<T> {
  const ensureReady = resolveManagedDeviceReadiness();
  if (!ensureReady) return Object.freeze(operations);
  return Object.freeze({
    ...withMethodScope({ ...operations }, (task) => withSimulatorReadiness(ensureReady, task)),
  });
}
