import type {
  HarmonyPlatformSelection,
  LinuxPlatformSelection,
  VegaPlatformSelection,
  WebPlatformSelection,
} from '@agent-device/contracts/platform-plugin';
import type { HostEnvironment } from '@agent-device/kernel/source-value';
import type { DeviceInfo, PlatformSelector } from '@agent-device/kernel/device';
import { normalizeError } from '@agent-device/kernel/errors';
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
export function createHostDiagnostics(
  host: HostEnvironment,
  web?: WebPlatformSelection,
  vega?: VegaPlatformSelection,
  harmony?: HarmonyPlatformSelection,
  linux?: LinuxPlatformSelection,
): HostDiagnostics {
  const { env } = host;
  return Object.freeze({
    toolchainCheck: async (
      platform: PlatformSelector | undefined,
      context: HostDiagnosticsContext,
    ): Promise<DoctorCheck | undefined> => {
      if (platform === 'android') {
        const { androidToolchainCheck } = await loadAndroidMechanics();
        return await androidToolchainCheck(env, process.platform);
      }
      if (platform === 'vega') {
        const { active } = vega ?? {};
        if (active) return await active.operations.toolchainCheck(context);
        return await pluginAbsenceCheck('Vega', vega);
      }
      if (platform === 'harmonyos') {
        const { active } = harmony ?? {};
        if (active) return await active.operations.toolchainCheck();
        return await pluginAbsenceCheck('HarmonyOS', harmony);
      }
      if (platform === 'linux') {
        const { active } = linux ?? {};
        if (active) return await active.operations.toolchainCheck();
        return await pluginAbsenceCheck('Linux', linux);
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
      if (!web?.active) return [];
      return [await web.active.operations.browserLifecycleCheck(context.stateDir)];
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

// Doctor reaches this only for a run whose selector named the family, so an inactive selection is
// the user's blocker rather than one family among many. The selection's own lookup owns the answer:
// an uninstalled plugin raises the typed plugin-not-installed outcome and a plugin whose load
// failed raises its own error, both through the composition's one absence reporter. The check
// reports that outcome's own fields; it never re-derives them.
async function pluginAbsenceCheck(
  label: string,
  selection: Readonly<{ get(): unknown }> | undefined,
): Promise<DoctorCheck | undefined> {
  if (!selection) return undefined;
  try {
    selection.get();
    return undefined;
  } catch (error) {
    const report = normalizeError(error);
    const installCommand = report.details?.installCommand;
    return {
      id: 'toolchain',
      status: 'fail',
      summary: `${label} toolchain: ${report.message}`,
      hint: report.hint,
      ...(typeof installCommand === 'string' ? { command: installCommand } : {}),
      evidence: { code: report.code, ...report.details },
    };
  }
}
