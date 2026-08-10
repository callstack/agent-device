import type { PlatformRuntimeOwner } from '@agent-device/contracts/platform';
import { createUnavailablePlatformRuntimeOwner } from '@agent-device/capture-kit';

const unavailable = Object.freeze({
  available: false,
  reason: 'unsupported-platform-leaf',
} as const);

export function createVegaPlatformRuntime(): PlatformRuntimeOwner {
  return createUnavailablePlatformRuntimeOwner('vega', {
    appLog: unavailable,
    network: unavailable,
  });
}
