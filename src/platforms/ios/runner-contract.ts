import crypto from 'node:crypto';
import { AppError } from '../../utils/errors.ts';
import type { ClickButton } from '../../core/click-button.ts';
import type { DeviceRotation } from '../../core/device-rotation.ts';
import type { ScrollDirection } from '../../core/scroll-gesture.ts';
import type { ElementSelectorKey } from '../../core/interactor-types.ts';
import { createRequestCanceledError, isRequestCanceled } from '../../daemon/request-cancel.ts';
import { bootFailureHint, classifyBootFailure } from '../boot-diagnostics.ts';
import type { RunnerSession } from './runner-session-types.ts';

const RUNNER_CACHE_RECOVERY_HINT =
  'If runner build products look stale or corrupted, run `pnpm clean:xcuitest` in a local checkout, or remove ~/.agent-device/ios-runner/derived, then retry.';

export type RunnerCommand = {
  command:
    | 'tap'
    | 'mouseClick'
    | 'longPress'
    | 'drag'
    | 'remotePress'
    | 'type'
    | 'swipe'
    // Fused frame-resolve + drag scroll (non-tvOS). Intentionally mutating in runner command
    // traits so it routes through single-send, command-id tracking, and lost-response status
    // recovery like other gestures.
    | 'scroll'
    | 'findText'
    | 'querySelector'
    | 'readText'
    | 'snapshot'
    | 'screenshot'
    | 'back'
    | 'backInApp'
    | 'backSystem'
    | 'home'
    | 'rotate'
    | 'rotateGesture'
    | 'transformGesture'
    | 'appSwitcher'
    | 'keyboardDismiss'
    | 'keyboardReturn'
    | 'alert'
    | 'pinch'
    | 'sequence'
    | 'recordStart'
    | 'recordStop'
    | 'status'
    | 'uptime'
    | 'shutdown';
  commandId?: string;
  statusCommandId?: string;
  appBundleId?: string;
  text?: string;
  selectorKey?: ElementSelectorKey;
  selectorValue?: string;
  allowNonHittableCoordinateFallback?: boolean;
  delayMs?: number;
  textEntryMode?: 'append' | 'replace';
  action?: 'get' | 'accept' | 'dismiss';
  x?: number;
  y?: number;
  button?: ClickButton;
  remoteButton?: 'select' | 'menu' | 'home' | 'up' | 'down' | 'left' | 'right';
  x2?: number;
  y2?: number;
  dx?: number;
  dy?: number;
  durationMs?: number;
  direction?: ScrollDirection;
  amount?: number;
  pixels?: number;
  orientation?: DeviceRotation;
  scale?: number;
  degrees?: number;
  velocity?: number;
  outPath?: string;
  fps?: number;
  maxSize?: number;
  interactiveOnly?: boolean;
  depth?: number;
  scope?: string;
  raw?: boolean;
  fullscreen?: boolean;
  synthesized?: boolean;
  steps?: RunnerSequenceStep[];
  /**
   * @deprecated Use textEntryMode: 'replace'. Kept for compatibility with older local runner clients.
   */
  clearFirst?: boolean;
};

/**
 * One allowlisted coordinate gesture step inside a fused `sequence` runner command.
 * The kind set is intentionally narrow (tap/longPress/drag) and validated on both the
 * daemon and runner sides — see runner-sequence.ts (the single interpretation point).
 */
export type RunnerSequenceStep = {
  kind: 'tap' | 'doubleTap' | 'longPress' | 'drag';
  x: number;
  y: number;
  x2?: number;
  y2?: number;
  durationMs?: number;
  pauseMs?: number;
  /**
   * For `tap` steps on iOS non-tv: use the synthesized HID tap (synthesizedTapAt) fast path
   * instead of the drag-based XCUICoordinate tapAt, matching the individual `tap` command.
   */
  synthesized?: boolean;
};

export function isRetryableRunnerError(err: unknown): boolean {
  if (!(err instanceof AppError)) return false;
  if (err.code !== 'COMMAND_FAILED') return false;
  const message = `${err.message ?? ''}`.toLowerCase();
  if (message.includes('xcodebuild exited early')) return false;
  if (message.includes('device is busy') && message.includes('connecting')) return false;
  if (message.includes('runner did not accept connection')) return true;
  if (message.includes('fetch failed')) return true;
  if (message.includes('econnrefused')) return true;
  if (message.includes('socket hang up')) return true;
  return false;
}

export function shouldRetryRunnerConnectError(error: unknown): boolean {
  if (!(error instanceof AppError)) return true;
  if (error.code !== 'COMMAND_FAILED') return true;
  const message = String(error.message ?? '').toLowerCase();
  if (message.includes('xcodebuild exited early')) return false;
  return true;
}

export function resolveRunnerEarlyExitHint(
  message: string,
  stdout: string,
  stderr: string,
): string {
  const haystack = `${message}\n${stdout}\n${stderr}`.toLowerCase();
  if (haystack.includes('device is busy') && haystack.includes('connecting')) {
    return 'Target iOS device is still connecting. Keep it unlocked, wait for device trust/connection to settle, then retry.';
  }
  return `${bootFailureHint('IOS_RUNNER_CONNECT_TIMEOUT')} ${RUNNER_CACHE_RECOVERY_HINT}`;
}

export function buildRunnerConnectError(params: {
  port: number;
  endpoints: string[];
  logPath?: string;
  lastError: unknown;
}): AppError {
  const { port, endpoints, logPath, lastError } = params;
  const message = 'Runner did not accept connection';
  return new AppError('COMMAND_FAILED', message, {
    port,
    endpoints,
    logPath,
    lastError: lastError ? String(lastError) : undefined,
    reason: classifyBootFailure({
      error: lastError,
      message,
      context: { platform: 'ios', phase: 'connect' },
    }),
    hint: bootFailureHint('IOS_RUNNER_CONNECT_TIMEOUT'),
  });
}

export async function buildRunnerEarlyExitError(params: {
  session: RunnerSession;
  port: number;
  logPath?: string;
}): Promise<AppError> {
  const { session, port, logPath } = params;
  const result = await session.testPromise;
  const message = 'Runner did not accept connection (xcodebuild exited early)';
  const reason = classifyBootFailure({
    message,
    stdout: result.stdout,
    stderr: result.stderr,
    context: { platform: 'ios', phase: 'connect' },
  });
  return new AppError('COMMAND_FAILED', message, {
    port,
    logPath,
    xcodebuild: {
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
    },
    reason,
    hint: resolveRunnerEarlyExitHint(message, result.stdout, result.stderr),
  });
}

function resolveSigningFailureHint(error: AppError): string | undefined {
  const details = error.details ? JSON.stringify(error.details) : '';
  const combined = `${error.message}\n${details}`.toLowerCase();
  if (
    combined.includes('failed registering bundle identifier') ||
    (combined.includes('app identifier') && combined.includes('not available'))
  ) {
    return 'Set AGENT_DEVICE_IOS_BUNDLE_ID to a unique reverse-DNS value (for example, com.yourname.agentdevice.runner), then retry.';
  }
  if (combined.includes('requires a development team')) {
    return 'Configure signing in Xcode or set AGENT_DEVICE_IOS_TEAM_ID for physical-device runs.';
  }
  if (combined.includes('no profiles for') || combined.includes('provisioning profile')) {
    return 'Install/select a valid iOS provisioning profile, or set AGENT_DEVICE_IOS_PROVISIONING_PROFILE.';
  }
  if (combined.includes('code signing')) {
    return 'Enable Automatic Signing in Xcode or provide AGENT_DEVICE_IOS_TEAM_ID and optional AGENT_DEVICE_IOS_SIGNING_IDENTITY.';
  }
  return undefined;
}

export function resolveRunnerBuildFailureHint(error: AppError): string {
  return resolveSigningFailureHint(error) ?? RUNNER_CACHE_RECOVERY_HINT;
}

export function withRunnerCommandId(command: RunnerCommand): RunnerCommand {
  if (command.command === 'status') return command;
  if (command.commandId?.trim()) return command;
  return { ...command, commandId: createRunnerCommandId() };
}

function createRunnerCommandId(): string {
  return `runner-${crypto.randomUUID()}`;
}

export function assertRunnerRequestActive(requestId: string | undefined): void {
  if (!isRequestCanceled(requestId)) return;
  throw createRequestCanceledError();
}
