import {
  createUnavailablePlatformRuntimeOwner,
  type PlatformRuntimeOwner,
} from '@agent-device/contracts/platform';

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
