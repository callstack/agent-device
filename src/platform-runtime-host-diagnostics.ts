import type { DeviceInfo, PlatformSelector } from '@agent-device/kernel/device';
import type { DoctorCheck } from '@agent-device/contracts/observability';
import type {
  HostDiagnostics,
  HostDiagnosticsContext,
} from '@agent-device/contracts/host-diagnostics';
import { loadAndroidMechanics } from './platform-runtime-android-mechanics.ts';

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
        const { androidToolchainCheck } = await loadAndroidMechanics();
        return await androidToolchainCheck(process.env);
      }
      if (platform === 'vega') {
        const { vegaToolchainCheck } = await import('@agent-device/platform-vega');
        return await vegaToolchainCheck(context);
      }
      if (platform === 'harmonyos') {
        const { harmonyToolchainCheck } = await import('@agent-device/platform-harmonyos');
        return await harmonyToolchainCheck();
      }
      if (platform === 'ios' || platform === 'macos' || platform === 'apple') {
        const { appleToolchainCheck } = await import('@agent-device/platform-apple/doctor');
        return await appleToolchainCheck();
      }
      return undefined;
    },
    deviceChecks: async (
      device: DeviceInfo,
      context: HostDiagnosticsContext,
    ): Promise<readonly DoctorCheck[]> => {
      if (device.platform !== 'android') return [];
      const { androidDeviceChecks } = await loadAndroidMechanics();
      return await androidDeviceChecks(device, context);
    },
    ambientChecks: async (context: HostDiagnosticsContext): Promise<readonly DoctorCheck[]> => {
      const { webBrowserLifecycleCheck } = await import('@agent-device/platform-web');
      return [await webBrowserLifecycleCheck(context.stateDir)];
    },
    warmupCheck: async (
      device: DeviceInfo,
      context: HostDiagnosticsContext,
    ): Promise<DoctorCheck | undefined> => {
      if (device.platform !== 'apple') return undefined;
      const { appleRunnerWarmupCheck } = await import('@agent-device/platform-apple/doctor');
      return await appleRunnerWarmupCheck(device, context);
    },
  });
}
