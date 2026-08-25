import type { DeviceInfo, PlatformSelector } from '@agent-device/kernel/device';
import type { DoctorCheck } from '@agent-device/contracts/observability';
import type {
  HostDiagnostics,
  HostDiagnosticsContext,
} from '@agent-device/contracts/host-diagnostics';

/**
 * Composes each family's host-scoped diagnostics behind the neutral surface (ADR 0019 host
 * execution). Families load lazily: a probe module is imported only when its family's method
 * actually runs, matching the platform registry's implementation-laziness.
 */
export function createHostDiagnostics(): HostDiagnostics {
  return Object.freeze({
    toolchainCheck: async (
      platform: PlatformSelector | undefined,
      context: HostDiagnosticsContext,
    ): Promise<DoctorCheck | undefined> => {
      if (platform === 'android') {
        const { androidToolchainCheck } = await import('./platforms/android/doctor.ts');
        return await androidToolchainCheck();
      }
      if (platform === 'vega') {
        const { vegaToolchainCheck } = await import('./platforms/vega/doctor.ts');
        return await vegaToolchainCheck(context);
      }
      if (platform === 'harmonyos') {
        const { harmonyToolchainCheck } = await import('./platforms/harmonyos/doctor.ts');
        return await harmonyToolchainCheck();
      }
      if (platform === 'ios' || platform === 'macos' || platform === 'apple') {
        const { appleToolchainCheck } = await import('./platforms/apple/doctor.ts');
        return await appleToolchainCheck();
      }
      return undefined;
    },
    deviceChecks: async (
      device: DeviceInfo,
      context: HostDiagnosticsContext,
    ): Promise<readonly DoctorCheck[]> => {
      if (device.platform !== 'android') return [];
      const { androidDeviceChecks } = await import('./platforms/android/doctor.ts');
      return await androidDeviceChecks(device, context);
    },
    ambientChecks: async (context: HostDiagnosticsContext): Promise<readonly DoctorCheck[]> => {
      const { webBrowserLifecycleCheck } = await import('./platforms/web/doctor.ts');
      return [await webBrowserLifecycleCheck(context.stateDir)];
    },
    warmupCheck: async (
      device: DeviceInfo,
      context: HostDiagnosticsContext,
    ): Promise<DoctorCheck | undefined> => {
      if (device.platform !== 'apple') return undefined;
      const { appleRunnerWarmupCheck } = await import('./platforms/apple/doctor.ts');
      return await appleRunnerWarmupCheck(device, context);
    },
  });
}
