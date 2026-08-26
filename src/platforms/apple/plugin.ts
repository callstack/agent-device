import type { PlatformPlugin } from '@agent-device/contracts/platform-plugin';
import type { DeviceInfo } from '@agent-device/kernel/device';
import type { RunnerContext } from '@agent-device/contracts/interactor-types';

// ---------------------------------------------------------------------------
// Apple family per-command capability closures for the commands still admitted by a capability
// bucket. Originally RELOCATED VERBATIM from src/core/command-descriptor/registry.ts (ADR-0009).
//
// R59/R63 deleted the per-`AppleOS` capability table (`apple-os-capabilities.ts`) along with the
// closures that read it: every command it served is now admitted from its owner's operation facts
// (ADR 0019 §8), so the OS-axis predicates live in `packages/platform-apple` rather than here.
// What remains is DEVICE-shaped nuance (simulator vs physical device, XCTest vs CoreDevice) for
// unmigrated commands, pinned against the original predicates by
// `capability-plugin-routing-parity` across the full {command x sample-device} matrix.
// ---------------------------------------------------------------------------

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
  capability: {
    bucket: 'apple',
  },
  // Declares the platform-gated request provider resolvers the Apple family owns: the
  // runner + tool providers (formerly gated by `isApplePlatform(device.platform)`).
  providers: { platformGatedResolvers: ['appleRunnerProvider', 'appleToolProvider'] },
  createInteractor: async (device: DeviceInfo, runner: RunnerContext) => {
    const { createAppleInteractor } = await import('./interactor.ts');
    return createAppleInteractor(device, runner);
  },
} as const satisfies PlatformPlugin;
