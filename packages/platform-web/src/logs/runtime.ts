import type { AppLogRuntimeOperations, DeviceRuntimeOwner } from '@agent-device/contracts/platform';
import { createUnavailableAppLogRuntimeOwner } from '@agent-device/capture-kit';

const unavailable = Object.freeze({
  available: false,
  reason: 'unsupported-platform-leaf',
} as const);

export function createWebAppLogRuntime(): DeviceRuntimeOwner<AppLogRuntimeOperations> {
  return createUnavailableAppLogRuntimeOwner('web', unavailable);
}
