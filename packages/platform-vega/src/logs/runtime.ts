import type { AppLogRuntimeOperations, DeviceRuntimeOwner } from '@agent-device/contracts/platform';
import { createUnavailableAppLogRuntimeOwner } from '@agent-device/contracts/platform';

const unavailable = Object.freeze({
  available: false,
  reason: 'unsupported-platform-leaf',
} as const);

export function createVegaAppLogRuntime(): DeviceRuntimeOwner<AppLogRuntimeOperations> {
  return createUnavailableAppLogRuntimeOwner('vega', unavailable);
}
