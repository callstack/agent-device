import { bindAndroidAdbHost } from '@agent-device/platform-android/adb-host';
import {
  coerceExecResult,
  execFailureDetails,
  runCmd,
  runCmdBackground,
  withCommandExecutorOverride,
  withoutCommandExecutorOverride,
} from '../../utils/exec.ts';
import { emitDiagnostic } from '../../utils/diagnostics.ts';
import {
  clearAndroidTestImeRecoveryMarker,
  readAndroidTestImeRecoveryMarkers,
  writeAndroidTestImeRecoveryMarker,
} from './ime-recovery-marker.ts';

// Composition wiring for the extracted adb/IME cluster (@agent-device/platform-android): the
// package owns transport and IME semantics; this file injects the raw host primitives R13 bars
// from platform packages. Every root shim of the cluster imports this module first, so the port
// is always bound before any cluster function can run.
bindAndroidAdbHost({
  execSerialAdb: async (serial, args, options) =>
    // Local adb execution must escape any active provider scope to avoid routing
    // tunnel-backed providers back into themselves when they shell out to adb.
    await withoutCommandExecutorOverride(
      async () =>
        await runCmd('adb', ['-s', serial, ...args], {
          ...options,
          // Some `adb shell` children can survive killing the adb parent and keep
          // requests open past timeout. Give each adb call its own process group
          // so timeout/abort cleanup can tear down the whole local command tree.
          detached: process.platform !== 'win32',
        }),
    ),
  spawnSerialAdb: (serial, args, options) => {
    const background = runCmdBackground('adb', ['-s', serial, ...args], {
      ...options,
      allowFailure: true,
      captureOutput: false,
    });
    void background.wait.catch(() => {});
    return background.child;
  },
  execHostAdb: async (args, options) => await runCmd('adb', args, options),
  withAdbCommandExecutorOverride: withCommandExecutorOverride,
  withoutAdbCommandExecutorOverride: withoutCommandExecutorOverride,
  coerceAdbResult: coerceExecResult,
  execFailureDetails,
  emitDiagnostic,
  imeRecoveryMarkers: {
    write: writeAndroidTestImeRecoveryMarker,
    clear: clearAndroidTestImeRecoveryMarker,
    read: readAndroidTestImeRecoveryMarkers,
  },
  resolveHelperArtifact: async (options) => {
    const { resolveAndroidHelperArtifact } = await import('./helper-package-install.ts');
    return await resolveAndroidHelperArtifact(options);
  },
  ensureHelperInstalled: async (config, request) => {
    const { makeEnsureAndroidHelperInstalled } = await import('./helper-package-install.ts');
    return await makeEnsureAndroidHelperInstalled(config)(request);
  },
});
