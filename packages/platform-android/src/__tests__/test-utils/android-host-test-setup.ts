import {
  coerceExecResult,
  execFailureDetails,
  runCmd,
  runCmdBackground,
  withCommandExecutorOverride,
  withoutCommandExecutorOverride,
} from '@agent-device/host-kit/command';
import { emitDiagnostic } from '@agent-device/host-kit/diagnostics';
import { bindAndroidAdbHostStub } from '../../adb-host.fixtures.ts';
import { createAndroidFileHost } from './android-file-host.ts';

export function bindAndroidAdbTestHost() {
  return bindAndroidAdbHostStub({
    environment: process.env,
    files: createAndroidFileHost(),
    execSerialAdb: async (serial, args, options) =>
      await withoutCommandExecutorOverride(
        async () =>
          await runCmd('adb', ['-s', serial, ...args], {
            ...options,
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
      write: async (stateDir, serial) => {
        const { writeAndroidTestImeRecoveryMarker } = await import('../../ime-recovery-marker.ts');
        return await writeAndroidTestImeRecoveryMarker(stateDir, serial);
      },
      clear: async (stateDir, serial) => {
        const { clearAndroidTestImeRecoveryMarker } = await import('../../ime-recovery-marker.ts');
        await clearAndroidTestImeRecoveryMarker(stateDir, serial);
      },
      read: async (stateDir) => {
        const { readAndroidTestImeRecoveryMarkers } = await import('../../ime-recovery-marker.ts');
        return await readAndroidTestImeRecoveryMarkers(stateDir);
      },
    },
    resolveHelperArtifact: async (options) => {
      const { resolveAndroidHelperArtifact } = await import('../../helper-package-install.ts');
      return await resolveAndroidHelperArtifact(options);
    },
    ensureHelperInstalled: async (config, request) => {
      const { makeEnsureAndroidHelperInstalled } = await import('../../helper-package-install.ts');
      return await makeEnsureAndroidHelperInstalled(config)(request);
    },
  });
}

export function bindMissingAndroidHelperHost(): void {
  const files = createAndroidFileHost();
  bindAndroidAdbHostStub({
    environment: process.env,
    files: {
      ...files,
      access: async () => {
        throw new Error('helper missing');
      },
    },
  });
}

export { mkdtempForTest } from './tmp-dir.ts';

bindAndroidAdbTestHost();
