import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  runCmd,
  withCommandHost,
  withoutCommandExecutorOverride,
} from '@agent-device/host-kit/command';
import { AppError } from '@agent-device/kernel/errors';
import {
  parseAndroidAdbArgv,
  requireManagedAndroidAdbCommand,
  requireManagedAndroidAdbSerial,
  serializeAndroidAdbInvocation,
  type AndroidAdbProvider,
} from '@agent-device/platform-android/mechanics';

export function adbExecutable(env: NodeJS.ProcessEnv) {
  const sdk = env.ANDROID_HOME || env.ANDROID_SDK_ROOT;
  return sdk ? path.join(sdk, 'platform-tools', 'adb') : 'adb';
}

export function adbEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    PATH: env.PATH,
    HOME: env.HOME,
    TMPDIR: env.TMPDIR,
    ANDROID_USER_HOME: env.ANDROID_USER_HOME,
    ANDROID_SDK_HOME: env.ANDROID_SDK_HOME,
    ADB_VENDOR_KEYS: env.ADB_VENDOR_KEYS,
    ADB_LOCAL_TRANSPORT_MAX_PORT: '1',
    ADB_MDNS_AUTO_CONNECT: '0',
  };
}

export function createAdbProvider(
  serial: string,
  socket: () => string,
  env: NodeJS.ProcessEnv,
): AndroidAdbProvider {
  const adb = adbExecutable(env);
  const childEnv = adbEnvironment(env);
  const scope = { host: { env: childEnv, cwd: '.' }, requestEnv: {} };
  function route(args: readonly string[], serverPort?: number) {
    const { target, command } = parseAndroidAdbArgv(args);
    if (target.hostGlobals || target.server.kind !== 'ambient' || serverPort !== undefined)
      throw new AppError('INVALID_ARGS', 'This Android lease owns its ADB server.');
    requireManagedAndroidAdbCommand(command);
    const selected = requireManagedAndroidAdbSerial(target, serial);
    const socketSpec = socket();
    return serializeAndroidAdbInvocation({
      target: { ...selected, hostGlobals: ['-L', socketSpec] },
      command,
    });
  }
  return {
    exec: async (args, options) => {
      const argv = route(args, options?.serverPort);
      const run = () => runCmd(adb, argv, { ...options, env: childEnv });
      const terminal = () => withoutCommandExecutorOverride(run);
      return await withCommandHost(scope, terminal);
    },
    spawn: (args, options) => {
      const argv = route(args, options?.serverPort);
      return spawn(adb, argv, {
        cwd: options?.cwd,
        stdio: options?.stdio,
        detached: options?.detached,
        signal: options?.signal,
        env: childEnv,
      });
    },
  };
}
