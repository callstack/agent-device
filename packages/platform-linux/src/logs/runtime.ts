import type { AppLogRuntimeOperations, DeviceRuntimeOwner } from '@agent-device/contracts/platform';
import { createUnavailableAppLogRuntimeOwner } from '@agent-device/contracts/platform';

const unavailable = Object.freeze({
  available: false,
  reason: 'unsupported-platform-leaf',
} as const);

export function createLinuxAppLogRuntime(): DeviceRuntimeOwner<AppLogRuntimeOperations> {
  return createUnavailableAppLogRuntimeOwner('linux', unavailable);
}
