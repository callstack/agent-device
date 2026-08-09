import type { AppLogRuntimeOperations, DeviceRuntimeOwner } from '@agent-device/contracts/platform';
import { createUnavailableAppLogRuntimeOwner } from '@agent-device/contracts/platform';

const unavailable = Object.freeze({
  available: false,
  reason: 'unsupported-platform-leaf',
} as const);

export function createWebAppLogRuntime(): DeviceRuntimeOwner<AppLogRuntimeOperations> {
  return createUnavailableAppLogRuntimeOwner('web', unavailable);
}
