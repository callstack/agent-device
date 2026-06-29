import { asAppError } from '../kernel/errors.ts';

export type BootFailureReason =
  | 'IOS_BOOT_TIMEOUT'
  | 'IOS_RUNNER_CONNECT_TIMEOUT'
  | 'IOS_TOOL_MISSING'
  | 'ANDROID_BOOT_TIMEOUT'
  | 'ADB_TRANSPORT_UNAVAILABLE'
  | 'CI_RESOURCE_STARVATION_SUSPECTED'
  | 'BOOT_COMMAND_FAILED'
  | 'UNKNOWN';

const INFRASTRUCTURE_BOOT_FAILURE_REASONS = new Set<BootFailureReason>([
  'IOS_BOOT_TIMEOUT',
  'IOS_RUNNER_CONNECT_TIMEOUT',
  'IOS_TOOL_MISSING',
  'ANDROID_BOOT_TIMEOUT',
  'ADB_TRANSPORT_UNAVAILABLE',
  'CI_RESOURCE_STARVATION_SUSPECTED',
]);

type BootDiagnosticContext = {
  platform?: 'ios' | 'android';
  phase?: 'boot' | 'connect' | 'transport';
};

export function isInfrastructureBootFailureReason(reason: string): boolean {
  return INFRASTRUCTURE_BOOT_FAILURE_REASONS.has(reason.toUpperCase() as BootFailureReason);
}

export function classifyBootFailure(input: {
  error?: unknown;
  message?: string;
  stdout?: string;
  stderr?: string;
  context?: BootDiagnosticContext;
}): BootFailureReason {
  const appErr = input.error ? asAppError(input.error) : null;
  const platform = input.context?.platform;
  const phase = input.context?.phase;
  if (appErr?.code === 'TOOL_MISSING') {
    return platform === 'android' ? 'ADB_TRANSPORT_UNAVAILABLE' : 'IOS_TOOL_MISSING';
  }
  const details = (appErr?.details ?? {}) as Record<string, unknown>;
  const detailMessage = typeof details.message === 'string' ? details.message : undefined;
  const detailStdout = typeof details.stdout === 'string' ? details.stdout : undefined;
  const detailStderr = typeof details.stderr === 'string' ? details.stderr : undefined;
  const nestedBoot =
    details.boot && typeof details.boot === 'object'
      ? (details.boot as Record<string, unknown>)
      : null;
  const nestedBootstatus =
    details.bootstatus && typeof details.bootstatus === 'object'
      ? (details.bootstatus as Record<string, unknown>)
      : null;

  const haystack = [
    input.message,
    appErr?.message,
    input.stdout,
    input.stderr,
    detailMessage,
    detailStdout,
    detailStderr,
    typeof nestedBoot?.stdout === 'string' ? nestedBoot.stdout : undefined,
    typeof nestedBoot?.stderr === 'string' ? nestedBoot.stderr : undefined,
    typeof nestedBootstatus?.stdout === 'string' ? nestedBootstatus.stdout : undefined,
    typeof nestedBootstatus?.stderr === 'string' ? nestedBootstatus.stderr : undefined,
  ]
    .filter(Boolean)
    .join('\n')
    .toLowerCase();

  if (
    platform === 'ios' &&
    (haystack.includes('runner did not accept connection') ||
      (phase === 'connect' &&
        (haystack.includes('timed out') ||
          haystack.includes('timeout') ||
          haystack.includes('econnrefused') ||
          haystack.includes('connection refused') ||
          haystack.includes('fetch failed') ||
          haystack.includes('socket hang up'))))
  ) {
    return 'IOS_RUNNER_CONNECT_TIMEOUT';
  }
  if (
    platform === 'ios' &&
    phase === 'boot' &&
    (haystack.includes('timed out') || haystack.includes('timeout'))
  ) {
    return 'IOS_BOOT_TIMEOUT';
  }
  if (
    platform === 'android' &&
    phase === 'boot' &&
    (haystack.includes('timed out') || haystack.includes('timeout'))
  ) {
    return 'ANDROID_BOOT_TIMEOUT';
  }
  if (
    haystack.includes('resource temporarily unavailable') ||
    haystack.includes('killed: 9') ||
    haystack.includes('cannot allocate memory') ||
    haystack.includes('system is low on memory')
  ) {
    return 'CI_RESOURCE_STARVATION_SUSPECTED';
  }
  if (
    platform === 'android' &&
    (haystack.includes('device not found') ||
      haystack.includes('no devices') ||
      haystack.includes('device offline') ||
      haystack.includes('offline') ||
      haystack.includes('unauthorized') ||
      haystack.includes('not authorized') ||
      haystack.includes('unable to locate device') ||
      haystack.includes('invalid device'))
  ) {
    return 'ADB_TRANSPORT_UNAVAILABLE';
  }
  if (appErr?.code === 'COMMAND_FAILED' || haystack.length > 0) return 'BOOT_COMMAND_FAILED';
  return 'UNKNOWN';
}

export function bootFailureHint(reason: BootFailureReason): string {
  switch (reason) {
    case 'IOS_BOOT_TIMEOUT':
      return 'Retry simulator boot and inspect simctl bootstatus logs; in CI reduce parallel jobs or use a larger runner.';
    case 'IOS_RUNNER_CONNECT_TIMEOUT':
      return 'Retry runner startup, inspect xcodebuild logs, and verify simulator responsiveness before command execution.';
    case 'ANDROID_BOOT_TIMEOUT':
      return 'Retry emulator startup and verify sys.boot_completed reaches 1; consider increasing startup budget in CI.';
    case 'ADB_TRANSPORT_UNAVAILABLE':
      return 'Check adb server/device transport (adb devices -l), restart adb, and ensure the target device is online and authorized.';
    case 'CI_RESOURCE_STARVATION_SUSPECTED':
      return 'CI machine may be resource constrained; reduce parallel jobs or use a larger runner.';
    case 'IOS_TOOL_MISSING':
      return 'Xcode command-line tools are missing or not in PATH; run xcode-select --install and verify xcrun works.';
    case 'BOOT_COMMAND_FAILED':
      return 'Inspect command stderr/stdout for the failing boot phase and retry after environment validation.';
    default:
      return 'Retry once and inspect verbose logs for the failing phase.';
  }
}
