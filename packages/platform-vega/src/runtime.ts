import {
  createUnavailablePlatformRuntimeOwner,
  type PlatformRuntimeOwner,
} from '@agent-device/contracts/platform';

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
