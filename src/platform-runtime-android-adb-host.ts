import { bindAndroidAdbHost } from '@agent-device/platform-android/adb-host';
import { createHash, randomUUID } from 'node:crypto';
import {
  coerceExecResult,
  execFailureDetails,
  runCmd,
  runCmdBackground,
  withCommandExecutorOverride,
  withoutCommandExecutorOverride,
} from '@agent-device/host-kit/command';
import { emitDiagnostic } from '@agent-device/host-kit/diagnostics';
import { constants as fsConstants } from 'node:fs';
import {
  access,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

bindAndroidAdbHost({
  environment: process.env,
  files: {
    access: async (candidate) => await access(candidate),
    ensureDirectory: async (directory) => {
      await mkdir(directory, { recursive: true });
    },
    isExecutable: async (candidate) => {
      try {
        await access(candidate, fsConstants.X_OK);
        return true;
      } catch {
        return false;
      }
    },
    makeTempDirectory: async (prefix) => await mkdtemp(path.join(os.tmpdir(), prefix)),
    readBytes: async (filePath) => await readFile(filePath),
    readDirectory: async (directory) => await readdir(directory),
    readText: async (filePath) => await readFile(filePath, 'utf8'),
    remove: async (target, options) => await rm(target, options),
    stat: async (filePath) => {
      const result = await stat(filePath);
      return { isFile: result.isFile(), size: result.size };
    },
    sha256: (value) => createHash('sha256').update(value).digest('hex'),
    writeAtomicText: async (filePath, value, mode = 0o600) => {
      const directory = path.dirname(filePath);
      const temporaryPath = path.join(directory, `.${path.basename(filePath)}.${randomUUID()}.tmp`);
      let handle: Awaited<ReturnType<typeof open>> | undefined;
      let published = false;
      try {
        handle = await open(temporaryPath, 'wx', mode);
        await handle.writeFile(value, 'utf8');
        await handle.sync();
        await handle.close();
        handle = undefined;
        await rename(temporaryPath, filePath);
        published = true;
        let directoryHandle: Awaited<ReturnType<typeof open>> | undefined;
        try {
          directoryHandle = await open(directory, 'r');
          await directoryHandle.sync();
        } catch {
        } finally {
          if (directoryHandle) await directoryHandle.close().catch(() => {});
        }
      } finally {
        if (handle) await handle.close().catch(() => {});
        if (!published) await rm(temporaryPath, { force: true }).catch(() => {});
      }
    },
    writeBytes: async (filePath, value) => await writeFile(filePath, value),
  },
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
      const { writeAndroidTestImeRecoveryMarker } =
        await import('@agent-device/platform-android/mechanics');
      return await writeAndroidTestImeRecoveryMarker(stateDir, serial);
    },
    clear: async (stateDir, serial) => {
      const { clearAndroidTestImeRecoveryMarker } =
        await import('@agent-device/platform-android/mechanics');
      await clearAndroidTestImeRecoveryMarker(stateDir, serial);
    },
    read: async (stateDir) => {
      const { readAndroidTestImeRecoveryMarkers } =
        await import('@agent-device/platform-android/mechanics');
      return await readAndroidTestImeRecoveryMarkers(stateDir);
    },
  },
  resolveHelperArtifact: async (options) => {
    const { resolveAndroidHelperArtifact } =
      await import('@agent-device/platform-android/mechanics');
    return await resolveAndroidHelperArtifact(options);
  },
  ensureHelperInstalled: async (config, request) => {
    const { makeEnsureAndroidHelperInstalled } =
      await import('@agent-device/platform-android/mechanics');
    return await makeEnsureAndroidHelperInstalled(config)(request);
  },
});
