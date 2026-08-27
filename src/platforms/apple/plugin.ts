import type { PlatformPlugin } from '@agent-device/contracts/platform-plugin';
import type { DeviceInfo } from '@agent-device/kernel/device';
import type { RunnerContext } from '@agent-device/contracts/interactor-types';

// The Apple plugin wraps today's existing interactor factory lazily.
// `as const satisfies PlatformPlugin` preserves
// the plugin's literal `platforms` tuple so the registry totality assertion (in
// `core/interactors/register-builtins.ts`) is a real compile-time check.

export const applePlugin = {
  id: 'apple',
  // Apple owns the single collapsed `apple` platform; the `appleOs` field
  // discriminates the OS (ADR-0009 / issue #979).
  platforms: ['apple'],
  familySelector: 'apple',
  // Declares the platform-gated request provider resolvers the Apple family owns: the
  // runner + tool providers (formerly gated by `isApplePlatform(device.platform)`).
  providers: { platformGatedResolvers: ['appleRunnerProvider', 'appleToolProvider'] },
  createInteractor: async (device: DeviceInfo, runner: RunnerContext) => {
    const { createAppleInteractor } = await import('./interactor.ts');
    return createAppleInteractor(device, runner);
  },
} as const satisfies PlatformPlugin;
