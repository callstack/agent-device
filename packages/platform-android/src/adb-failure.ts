import { AppError } from '@agent-device/kernel/errors';
import type { HostCommandResult } from '@agent-device/contracts/platform';

type AdbFailure = Readonly<{
  reason: string;
  hint: string;
  retriable?: boolean;
}>;

const MATCHERS: readonly (AdbFailure & { pattern: RegExp })[] = [
  {
    reason: 'device_unauthorized',
    pattern: /device unauthorized|device still authorizing/,
    hint: 'USB debugging is not authorized — accept the authorization prompt on the device screen (re-plug the cable if none appears), then retry.',
  },
  {
    reason: 'device_offline',
    pattern: /device offline/,
    hint: 'The device is connected but offline — wait for it to finish booting or run adb reconnect, then retry.',
    retriable: true,
  },
  {
    reason: 'multiple_devices',
    pattern: /more than one (?:device\/emulator|device and emulator)/,
    hint: 'Multiple Android devices are connected — pass --serial <serial> (see adb devices) to select one.',
  },
  {
    reason: 'no_devices',
    pattern: /no devices\/emulators found|no devices found/,
    hint: 'No Android devices detected — boot an emulator or connect a device and verify it appears in adb devices.',
  },
  {
    reason: 'device_not_found',
    pattern: /device (?:'[^']*' )?not found/,
    hint: 'The device disconnected or is restarting — verify it is listed in adb devices, then retry.',
    retriable: true,
  },
  {
    reason: 'connection_dropped',
    pattern: /transport error|connection reset|broken pipe|protocol fault/,
    hint: 'The adb connection dropped — retry; if it persists, run adb kill-server and reconnect the device.',
    retriable: true,
  },
];

export function androidDiscoveryCommandError(
  message: string,
  result: HostCommandResult,
  fallbackHint: string,
): AppError {
  const failure = classifyAdbFailure(`${result.stdout}\n${result.stderr}`);
  return new AppError('COMMAND_FAILED', message, {
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
    processExitError: true,
    hint: failure?.hint ?? fallbackHint,
    ...(failure ? { adbFailure: failure.reason } : {}),
    ...(failure?.retriable === undefined ? {} : { retriable: failure.retriable }),
  });
}

export function attachAndroidDiscoveryTimeout<T>(error: T): T {
  if (
    !(error instanceof AppError) ||
    error.code !== 'COMMAND_FAILED' ||
    typeof error.details?.timeoutMs !== 'number'
  ) {
    return error;
  }
  error.details = {
    ...error.details,
    adbFailure: 'timeout',
    ...(typeof error.details.hint === 'string'
      ? {}
      : {
          hint: 'adb timed out — the adb server may be wedged. Run adb kill-server && adb start-server, check adb devices, then retry.',
        }),
  };
  return error;
}

function classifyAdbFailure(stderr: string): AdbFailure | undefined {
  const normalized = stderr.toLowerCase();
  for (const { pattern, ...failure } of MATCHERS) {
    if (pattern.test(normalized)) return failure;
  }
  return undefined;
}
