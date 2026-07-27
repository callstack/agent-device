import fs from 'node:fs';
import path from 'node:path';
import { buildSimctlArgs } from '../platforms/apple/core/simctl.ts';
import { AppError } from '../kernel/errors.ts';
import { runCmd, runCmdBackground } from '../utils/exec.ts';
import { runXcrun } from '../platforms/apple/core/tool-provider.ts';
import {
  buildCoreDeviceConsoleLaunchArgs,
  checkCoreDeviceConsoleCaptureSupport,
  type CoreDeviceConsoleCaptureSupport,
} from '../platforms/apple/core/physical-device-console.ts';
import {
  clearPidFile,
  writePidFile,
  type AppLogResult,
  type AppLogState,
} from './app-log-process.ts';
import { attachChildToStream, createLineWriter, waitForChildExit } from './app-log-stream.ts';

export const IOS_DEVICE_CONSOLE_CAPTURE_UNSUPPORTED = {
  message: 'iOS physical-device app console capture is not supported by the installed devicectl.',
  hint: 'This devicectl does not expose process launch --console. Markers can still be written to app.log, but app output is not being captured. Use an iOS simulator for agent-device app logs or inspect physical-device logs in Console.app/Xcode until this Xcode toolchain exposes scriptable console capture.',
} as const;
const IOS_DEVICE_CONSOLE_CAPTURE_PROBE_FAILED = {
  message: 'Could not verify iOS physical-device app console capture support.',
  hint: 'Retry logs clear --restart. If the probe keeps failing, run logs doctor and inspect the request diagnostics for the devicectl help command.',
} as const;
export const IOS_DEVICE_CONSOLE_CAPTURE_UNSUPPORTED_NOTE = formatIosDeviceConsoleCaptureNote(
  IOS_DEVICE_CONSOLE_CAPTURE_UNSUPPORTED,
);
export const IOS_DEVICE_CONSOLE_CAPTURE_PROBE_FAILED_NOTE = formatIosDeviceConsoleCaptureNote(
  IOS_DEVICE_CONSOLE_CAPTURE_PROBE_FAILED,
);

export type IosDeviceConsoleCaptureSupport = CoreDeviceConsoleCaptureSupport;

export function buildAppleLogPredicate(
  appBundleId: string,
  executableName?: string | undefined,
): string {
  const escapedBundleId = escapeAppleLogPredicateString(appBundleId);
  const clauses = [
    `subsystem == "${escapedBundleId}"`,
    // App frameworks/extensions often log through subsystem names prefixed by the app bundle id.
    `subsystem CONTAINS "${escapedBundleId}"`,
    `processImagePath ENDSWITH[c] "/${escapedBundleId}"`,
    `senderImagePath ENDSWITH[c] "/${escapedBundleId}"`,
  ];
  if (executableName) {
    const escapedExecutable = escapeAppleLogPredicateString(executableName);
    clauses.push(
      `process == "${escapedExecutable}"`,
      `processImagePath ENDSWITH[c] "/${escapedExecutable}"`,
      `senderImagePath ENDSWITH[c] "/${escapedExecutable}"`,
      `processImagePath CONTAINS[c] "/${escapedExecutable}.app/"`,
      `senderImagePath CONTAINS[c] "/${escapedExecutable}.app/"`,
    );
  }
  return clauses.join(' OR ');
}

export function buildIosSimulatorLogStreamArgs(params: {
  deviceId: string;
  appBundleId: string;
  executableName?: string | undefined;
  simulatorSetPath?: string;
}): string[] {
  const { deviceId, appBundleId, executableName, simulatorSetPath } = params;
  return buildSimctlArgs(
    [
      'spawn',
      deviceId,
      'log',
      'stream',
      '--style',
      'compact',
      '--level',
      'info',
      '--predicate',
      buildAppleLogPredicate(appBundleId, executableName),
    ],
    { simulatorSetPath },
  );
}

export function buildIosDeviceConsoleLaunchArgs(deviceId: string, appBundleId: string): string[] {
  return buildCoreDeviceConsoleLaunchArgs(deviceId, appBundleId);
}

export async function checkIosDeviceConsoleCaptureSupport(): Promise<IosDeviceConsoleCaptureSupport> {
  return await checkCoreDeviceConsoleCaptureSupport();
}

function formatIosDeviceConsoleCaptureNote(message: { message: string; hint: string }): string {
  return `${message.message} ${message.hint}`;
}

export async function readRecentIosSimulatorLogShowForBundle(params: {
  deviceId: string;
  appBundleId: string;
  executableName?: string | undefined;
  startedAt?: number;
  simulatorSetPath?: string;
}): Promise<{ text: string; recoveredLineCount: number } | null> {
  const { deviceId, appBundleId, executableName, startedAt, simulatorSetPath } = params;
  const args = buildSimctlArgs(
    [
      'spawn',
      deviceId,
      'log',
      'show',
      '--style',
      'compact',
      '--info',
      '--predicate',
      buildAppleLogPredicate(appBundleId, executableName),
    ],
    { simulatorSetPath },
  );
  if (typeof startedAt === 'number' && Number.isFinite(startedAt) && startedAt > 0) {
    args.push('--start', `@${Math.floor(startedAt / 1000)}`);
  } else {
    args.push('--last', '5m');
  }
  const result = await runXcrun(args, { allowFailure: true, timeoutMs: 4_000 });
  if (result.exitCode !== 0 || result.stdout.trim().length === 0) {
    return null;
  }
  const lines = result.stdout
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => {
      const trimmed = line.trim();
      return (
        trimmed.length > 0 && !trimmed.startsWith('Timestamp               Ty Process[PID:TID]')
      );
    });
  if (lines.length === 0) {
    return null;
  }
  return {
    text: `${lines.join('\n')}\n`,
    recoveredLineCount: lines.length,
  };
}

export async function startIosSimulatorAppLog(
  deviceId: string,
  appBundleId: string,
  stream: fs.WriteStream,
  redactionPatterns: RegExp[],
  simulatorSetPath?: string,
  pidPath?: string,
): Promise<AppLogResult> {
  const executableName = await resolveIosSimulatorExecutableName({
    deviceId,
    appBundleId,
    simulatorSetPath,
  });
  return startAppleAppLogStream({
    backend: 'ios-simulator',
    cmd: 'xcrun',
    args: buildIosSimulatorLogStreamArgs({
      deviceId,
      appBundleId,
      executableName,
      simulatorSetPath,
    }),
    stream,
    redactionPatterns,
    pidPath,
  });
}

function escapeAppleLogPredicateString(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
}

async function resolveIosSimulatorExecutableName(params: {
  deviceId: string;
  appBundleId: string;
  simulatorSetPath?: string;
}): Promise<string | undefined> {
  const { deviceId, appBundleId, simulatorSetPath } = params;
  const container = await runXcrun(
    buildSimctlArgs(['get_app_container', deviceId, appBundleId, 'app'], { simulatorSetPath }),
    { allowFailure: true, timeoutMs: 4_000 },
  );
  if (container.exitCode !== 0) return undefined;
  const appPath = container.stdout.trim();
  if (!appPath) return undefined;
  const plistPath = path.join(appPath, 'Info.plist');
  const executable = await runCmd(
    'plutil',
    ['-extract', 'CFBundleExecutable', 'raw', '-o', '-', plistPath],
    { allowFailure: true, timeoutMs: 4_000 },
  );
  if (executable.exitCode !== 0) return undefined;
  return executable.stdout.trim() || undefined;
}

export async function startMacOsAppLog(
  appBundleId: string,
  stream: fs.WriteStream,
  redactionPatterns: RegExp[],
  pidPath?: string,
): Promise<AppLogResult> {
  return startAppleAppLogStream({
    backend: 'macos',
    cmd: 'log',
    args: ['stream', '--style', 'compact', '--predicate', buildAppleLogPredicate(appBundleId)],
    stream,
    redactionPatterns,
    pidPath,
  });
}

export async function startIosDeviceAppLog(
  deviceId: string,
  appBundleId: string,
  stream: fs.WriteStream,
  redactionPatterns: RegExp[],
  pidPath?: string,
): Promise<AppLogResult> {
  const support = await checkIosDeviceConsoleCaptureSupport();
  if (!support.supported) {
    stream.end();
    throw buildIosDeviceConsoleCaptureError(support);
  }
  return startAppleAppLogStream({
    backend: 'ios-device',
    cmd: 'xcrun',
    args: buildIosDeviceConsoleLaunchArgs(deviceId, appBundleId),
    stream,
    redactionPatterns,
    pidPath,
    stopSignals: ['SIGKILL'],
  });
}

function buildIosDeviceConsoleCaptureError(
  support: Extract<IosDeviceConsoleCaptureSupport, { supported: false }>,
): AppError {
  if (support.reason === 'probe-failed') {
    return new AppError('COMMAND_FAILED', IOS_DEVICE_CONSOLE_CAPTURE_PROBE_FAILED.message, {
      backend: 'ios-device',
      hint: IOS_DEVICE_CONSOLE_CAPTURE_PROBE_FAILED.hint,
      stderr: support.stderr,
    });
  }
  return new AppError('UNSUPPORTED_OPERATION', IOS_DEVICE_CONSOLE_CAPTURE_UNSUPPORTED.message, {
    backend: 'ios-device',
    hint: IOS_DEVICE_CONSOLE_CAPTURE_UNSUPPORTED.hint,
    stderr: support.stderr,
  });
}

function startAppleAppLogStream(params: {
  backend: AppLogResult['backend'];
  cmd: string;
  args: string[];
  stream: fs.WriteStream;
  redactionPatterns: RegExp[];
  pidPath?: string;
  stopSignals?: NodeJS.Signals[];
}): AppLogResult {
  let state: AppLogState = 'active';
  const background = runCmdBackground(params.cmd, params.args, {
    allowFailure: true,
    captureOutput: false,
  });
  void background.wait.catch(() => {});
  const child = background.child;
  const writer = createLineWriter(params.stream, { redactionPatterns: params.redactionPatterns });
  if (typeof child.pid === 'number') {
    writePidFile(params.pidPath, child.pid);
  }
  const wait = attachChildToStream(child, params.stream, {
    endStreamOnClose: true,
    writer,
  }).then(
    (result) => {
      state = result.exitCode === 0 ? 'ended' : 'failed';
      clearPidFile(params.pidPath);
      return result;
    },
    (error: unknown) => {
      state = 'failed';
      clearPidFile(params.pidPath);
      throw error;
    },
  );
  return {
    backend: params.backend,
    getState: () => state,
    startedAt: Date.now(),
    wait,
    stop: async () => {
      for (const signal of params.stopSignals ?? ['SIGINT', 'SIGKILL']) {
        child.kill(signal);
        await waitForChildExit(wait);
      }
      clearPidFile(params.pidPath);
    },
  };
}
