import { bindAndroidAdbHost } from '@agent-device/platform-android/adb-host';
import type { AndroidAdbExecutorOptions } from '@agent-device/platform-android/mechanics';
import { AppError } from '@agent-device/kernel/errors';
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

const environment = process.env;

bindAndroidAdbHost({
  environment,
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
  execSerialAdb: async (serial, args, options) => {
    const invocation = adbInvocation(['-s', serial, ...args], options);
    return await withoutCommandExecutorOverride(
      async () =>
        await runCmd('adb', invocation.args, {
          ...invocation.options,
          detached: process.platform !== 'win32',
        }),
    );
  },
  spawnSerialAdb: (serial, args, options) => {
    const invocation = adbInvocation(['-s', serial, ...args], options);
    const background = runCmdBackground('adb', invocation.args, {
      ...invocation.options,
      allowFailure: true,
      captureOutput: false,
    });
    void background.wait.catch(() => {});
    return background.child;
  },
  execHostAdb: async (args, options) => {
    const invocation = adbInvocation(args, options);
    return await runCmd('adb', invocation.args, invocation.options);
  },
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

function adbInvocation<Options extends AndroidAdbExecutorOptions>(
  args: string[],
  options?: Options,
): { args: string[]; options: Omit<Options, 'serverPort'> } {
  const { serverPort, ...withoutServerPort } = options ?? ({} as Options);
  if (serverPort === undefined) return { args, options: withoutServerPort };
  return {
    args: withServerPort(args, serverPort),
    options: {
      ...withoutServerPort,
      env: {
        ...environment,
        ...(withoutServerPort.env ?? {}),
        ADB_SERVER_SOCKET: undefined,
        ANDROID_ADB_SERVER_PORT: String(serverPort),
        ANDROID_ADB_SERVER_ADDRESS: '127.0.0.1',
      },
    },
  };
}

function withServerPort(args: string[], serverPort: number): string[] {
  const normalized = ['-P', String(serverPort)];
  let index = 0;
  let serial: string | undefined;
  while (index < args.length) {
    const argument = args[index];
    if (argument === '-P') {
      index += 2;
      continue;
    }
    if (argument === '-s') {
      if (serial !== undefined && serial !== args[index + 1]) throw transportMismatch();
      serial = args[index + 1];
      normalized.push(argument, args[index + 1]!);
      index += 2;
      continue;
    }
    if (argument?.startsWith('-')) throw transportMismatch();
    break;
  }
  const command = args.slice(index);
  assertManagedAdbCommand(command);
  return [...normalized, ...command];
}

function assertManagedAdbCommand(args: string[]): void {
  const command = args.find((argument) => !argument.startsWith('wait-for-'));
  if (
    [
      'nodaemon',
      'server',
      'fork-server',
      'kill-server',
      'start-server',
      'connect',
      'disconnect',
      'reconnect',
      'attach',
      'detach',
      'pair',
    ].includes(command ?? '')
  ) {
    throw transportMismatch();
  }
}

function transportMismatch(): AppError {
  return new AppError('COMMAND_FAILED', 'Managed ADB transport cannot select another target.', {
    reason: 'managed-device-transport-mismatch',
  });
}
