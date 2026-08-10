import type { PlatformRuntimeOwner } from '@agent-device/contracts/platform';
import { createUnavailablePlatformRuntimeOwner } from '@agent-device/capture-kit';

const unavailable = Object.freeze({
  available: false,
  reason: 'unsupported-platform-leaf',
} as const);

export function createLinuxPlatformRuntime(): PlatformRuntimeOwner {
  return createUnavailablePlatformRuntimeOwner('linux', {
    appLog: unavailable,
    network: unavailable,
  });
}
