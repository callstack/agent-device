import type {
  AppLogProcessCommand,
  AppLogProcessTransport,
} from '@agent-device/contracts/app-log-runtime';
import type { HostCommandResult } from '@agent-device/contracts/platform-runtime-host';
import type { DeviceInfo } from '@agent-device/kernel/device';
import type { AndroidAdbProcess } from './platforms/android/adb-executor.ts';
import {
  createManagedAppLogProcesses,
  type ManagedAppLogCommand,
} from './platform-runtime-app-log-process.ts';

export async function resolveAndroidAppLogProcessTransport(
  sessionsDir: string,
  device: DeviceInfo,
  local: AppLogProcessTransport,
): Promise<AppLogProcessTransport> {
  const { resolveScopedAndroidAdbBackgroundTransport } =
    await import('./platforms/android/adb-executor.ts');
  const transport = resolveScopedAndroidAdbBackgroundTransport(device);
  if (transport.mode === 'local') return local;
  if (!transport.spawn) return Object.freeze({ mode: 'transport-composed' });
  const spawn = transport.spawn;
  const processes = createManagedAppLogProcesses(sessionsDir, {
    launch: async (command, signal) => {
      signal?.throwIfAborted();
      const adb = providerAdbCommand(command, device.id);
      const child = spawn([...adb.args], {
        allowFailure: adb.options?.allowFailure,
        cwd: adb.options?.cwd,
        env: adb.options?.env ? { ...process.env, ...adb.options.env } : undefined,
        timeoutMs: adb.options?.timeoutMs,
        captureOutput: false,
        signal,
      });
      return providerBackgroundCommand(child);
    },
  });
  return Object.freeze({ mode: 'transport-composed', start: processes.start });
}

function providerAdbCommand(
  command: AppLogProcessCommand,
  deviceId: string,
): Extract<AppLogProcessCommand, { kind: 'android-adb' }> {
  if (command.kind !== 'android-adb' || command.serial !== deviceId) {
    throw new Error('Android app-log provider transport received a non-device-scoped adb command');
  }
  return command;
}

function providerBackgroundCommand(child: AndroidAdbProcess): ManagedAppLogCommand {
  return Object.freeze({ child, wait: waitForProviderProcess(child) });
}

function waitForProviderProcess(child: AndroidAdbProcess): Promise<HostCommandResult> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (result: HostCommandResult | Error) => {
      if (settled) return;
      settled = true;
      if (result instanceof Error) reject(result);
      else resolve(result);
    };
    child.on('error', (error) => settle(error));
    child.once('close', (code, signal) =>
      settle({
        stdout: '',
        stderr: '',
        exitCode: code ?? (signal ? 1 : 0),
      }),
    );
    if (child.exitCode !== null && child.exitCode !== undefined) {
      queueMicrotask(() => settle({ stdout: '', stderr: '', exitCode: child.exitCode ?? 0 }));
    }
  });
}
