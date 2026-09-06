import type {
  AndroidApplicationTools,
  OpenTargetResolution,
  OpenTargetResolutionInput,
} from '@agent-device/contracts/application-lifecycle-runtime';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import { emitDiagnostic } from '@agent-device/host-kit/diagnostics';
import { loadAndroidMechanics } from './platform-runtime-android-mechanics.ts';

/**
 * One memoized loader per lazily imported module, and the only way the ports below reach one.
 * See the same loaders in `platform-runtime-apple-application-tools.ts` for why a port never
 * opens its own `import(...)` (#2314).
 */
let openTargetModule: Promise<typeof import('./platform-runtime-open-target.ts')> | undefined;
const loadOpenTarget = () => (openTargetModule ??= import('./platform-runtime-open-target.ts'));

let runtimeHintsModule: Promise<typeof import('./platform-runtime-runtime-hints.ts')> | undefined;
const loadRuntimeHints = () =>
  (runtimeHintsModule ??= import('./platform-runtime-runtime-hints.ts'));

/** Lazy Android tools; the Android package owns lifecycle sequencing and durable IME policy. */
export function createAndroidApplicationTools(): AndroidApplicationTools {
  return Object.freeze({
    resolveOpenTarget: async (device, input) => await resolveAndroidOpenTarget(device, input),
    inferOpenedAppBundleId: async (device, target, currentAppBundleId) => {
      const { inferAndroidPackageAfterOpen } = await loadOpenTarget();
      return await inferAndroidPackageAfterOpen(device, target, currentAppBundleId);
    },
    resetFramePerfStats: async (device, appBundleId) => {
      const { resetAndroidFramePerfStats } = await loadAndroidMechanics();
      await resetAndroidFramePerfStats(device, appBundleId);
    },
    applyRuntimeHints: async (device, input) => {
      const { applyRuntimeHintValues } = await loadRuntimeHints();
      await applyRuntimeHintValues({ device, ...input });
    },
    clearRuntimeHints: async (device, input) => {
      const { clearRuntimeHintValues } = await loadRuntimeHints();
      await clearRuntimeHintValues({ device, ...input });
    },
    activateTestIme: async (device, input) => {
      const { activateAndroidTestIme } = await loadAndroidMechanics();
      // Anything this rejects with — startup fence, recovery lock, or a failure after durable
      // state was touched — propagates. Test IME is an opt-out text-entry accelerator, so only the
      // typed helper-unavailable outcome falls back to the ordinary text-entry path.
      const result = await activateAndroidTestIme(device, input);
      if (result.outcome === 'helper-unavailable') {
        emitDiagnostic({
          level: 'warn',
          phase: 'android_test_ime_activate_failed',
          data: { device: device.id, error: result.reason },
        });
        return;
      }
      if (!result.persistFailed) return;
      // Persistence can fail before the IME switch. In that case the durable invariant held and
      // ordinary text entry is still safe, so keep `open` successful. An already-active helper
      // without a fresh recovery marker remains unsafe and continues to fail closed below.
      if (!result.alreadyActive && !result.activated) {
        return;
      }
      throw new AppError(
        'COMMAND_FAILED',
        `Android test IME recovery records could not be persisted for ${device.name ?? device.id}.`,
        { reason: 'android_test_ime_recovery_fence_failed', deviceId: device.id },
      );
    },
    restoreTestIme: async (device, input) => {
      const { restoreAndroidTestIme } = await loadAndroidMechanics();
      const result = await restoreAndroidTestIme(device, { stateDir: input.stateDir });
      if (result.reason !== 'set-failed') return;
      throw new AppError(
        'COMMAND_FAILED',
        `Android test IME could not be restored on ${device.name ?? device.id}.`,
        { reason: 'android_test_ime_restore_incomplete', deviceId: device.id },
      );
    },
    recoverTestImeStartup: async (input) => {
      const { listAndroidAdbSerialsQuick, restoreOrphanedAndroidTestImeOnDaemonStartup } =
        await loadAndroidMechanics();
      await restoreOrphanedAndroidTestImeOnDaemonStartup({
        stateDir: input.stateDir,
        listSerials: listAndroidAdbSerialsQuick,
      });
    },
    hasTestImeRecoveryEvidence: async (stateDir) => {
      const { readAndroidTestImeRecoveryMarkers } = await loadAndroidMechanics();
      return (await readAndroidTestImeRecoveryMarkers(stateDir)).length > 0;
    },
  });
}

async function resolveAndroidOpenTarget(
  device: DeviceInfo,
  input: OpenTargetResolutionInput,
): Promise<OpenTargetResolution> {
  const { resolveAndroidPackageForOpen, resolveSessionAppBundleIdForTarget } =
    await loadOpenTarget();
  return {
    appBundleId: await resolveSessionAppBundleIdForTarget(
      device,
      input.target,
      input.currentAppBundleId,
      resolveAndroidPackageForOpen,
    ),
    appName: input.target,
  };
}
