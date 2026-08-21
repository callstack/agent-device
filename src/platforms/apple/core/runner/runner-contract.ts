import { AppError, createRequestCanceledError } from '@agent-device/kernel/errors';
import crypto from 'node:crypto';
import type { DeviceRotation } from '@agent-device/contracts/device';
import type { SnapshotPreferredBackend } from '@agent-device/kernel/snapshot';
import type {
  ClickButton,
  ElementSelectorKey,
  GesturePlan,
  ScrollDirection,
  ScrollReleaseBehavior,
} from '@agent-device/contracts/interaction';
import { getRequestSignal, isRequestCanceled } from '../../../../request/cancel.ts';
import {
  bootFailureHint,
  classifyBootFailure,
  type BootFailureReason,
} from '../../../boot-diagnostics.ts';
import type { RunnerSession } from './runner-session-types.ts';

const RUNNER_CACHE_RECOVERY_HINT =
  'If runner build products look stale or corrupted, run `pnpm clean:xcuitest` in a local checkout, or remove ~/.agent-device/apple-runner/derived, then retry.';

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
    // macOS-only frame-resolve + desktop wheel scroll. Kept distinct from `scroll` so mobile
    // touch drag semantics remain stable.
    | 'desktopScroll'
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
    | 'gesture'
    | 'gestureViewport'
    | 'appSwitcher'
    | 'keyboardDismiss'
    | 'keyboardReturn'
    | 'alert'
    | 'sequence'
    | 'recordStart'
    | 'recordStop'
    | 'status'
    | 'uptime'
    | 'activate'
    | 'terminate'
    | 'targetReset'
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
  durationMs?: number;
  /** Remaining request budget for runner work that performs bounded XCTest queries. */
  timeoutMs?: number;
  direction?: ScrollDirection;
  amount?: number;
  pixels?: number;
  scrollReleaseBehavior?: ScrollReleaseBehavior;
  orientation?: DeviceRotation;
  /** Canonical pointer samples planned by the portable gesture runtime. */
  gesturePlan?: GesturePlan;
  outPath?: string;
  fps?: number;
  interactiveOnly?: boolean;
  /** Pin the snapshot capture backend (same-backend evidence probes). */
  preferredBackend?: SnapshotPreferredBackend;
  /**
   * Read accessibility custom actions for merged leaves. Opt-in: each element
   * costs its own AX round trip, and the runner pins the private-AX backend
   * because no other backend can carry them.
   */
  customActions?: boolean;
  depth?: number;
  scope?: string;
  raw?: boolean;
  fullscreen?: boolean;
  inlineScreenshot?: boolean;
  synthesized?: boolean;
  steps?: RunnerSequenceStep[];
};

/**
 * One allowlisted coordinate gesture step inside a fused `sequence` runner command.
 * The kind set is intentionally narrow (tap/doubleTap/longPress) and validated on both the
 * daemon and runner sides — see runner-sequence.ts (the single interpretation point).
 */
export type RunnerSequenceStep = {
  kind: 'tap' | 'doubleTap' | 'longPress';
  x: number;
  y: number;
  durationMs?: number;
  pauseMs?: number;
  /**
   * For `tap` steps on iOS non-tv: use the synthesized HID tap (synthesizedTapAt) fast path
   * instead of the drag-based XCUICoordinate tapAt, matching the individual `tap` command.
   */
  synthesized?: boolean;
};

export function resolveRunnerRequestSignal(options: {
  requestId?: string;
  signal?: AbortSignal;
}): AbortSignal | undefined {
  const registeredSignal = getRequestSignal(options.requestId);
  if (!options.signal) return registeredSignal;
  if (!registeredSignal || registeredSignal === options.signal) return options.signal;
  return AbortSignal.any([registeredSignal, options.signal]);
}

type RunnerErrorMatch = {
  /** Required `AppError.code`; absent = any AppError. */
  code?: string;
  /** Every entry must appear in the lowercased message. */
  messageIncludesAll?: readonly string[];
  /** Required details evidence beyond code/message. */
  details?: 'retriable' | 'usbmux-device-unattached';
};

type RunnerErrorVerdicts = {
  /** isRetryableRunnerError: transport error worth a same-session resend. */
  retryable?: boolean;
  /** shouldRetryRunnerConnectError: connect loop may keep waiting for the runner. */
  connectRetry?: boolean;
  /** Session-fatal classification: invalidate the cached runner session with this reason. */
  sessionFatalReason?: string;
  /** Connect-shaped failure before the command was sent: restart the session and replay. */
  restartBeforeSend?: boolean;
};

type RunnerErrorRule = {
  /** Stable rule name for tests and diagnostics. */
  reason: string;
  match: RunnerErrorMatch;
  verdicts: RunnerErrorVerdicts;
};

/**
 * The one declaration of runner error classes (#1631), mirroring
 * RUNNER_COMMAND_TRAIT_MANIFEST's role for commands: every recovery predicate
 * below derives from this table instead of keeping its own substring chain.
 * Per axis, the FIRST matching rule that defines the axis wins — which is why
 * `flagged_retriable` precedes the denials (an explicitly retriable error
 * stays retriable whatever its message says), and `usbmux_device_unattached`
 * sits first (retrying cannot attach a cable, and its typed verdict carries
 * the recovery hint a generic connect failure would replace).
 */
export const RUNNER_ERROR_RULES: readonly RunnerErrorRule[] = [
  {
    reason: 'usbmux_device_unattached',
    match: { code: 'DEVICE_NOT_FOUND', details: 'usbmux-device-unattached' },
    verdicts: { connectRetry: false },
  },
  {
    reason: 'flagged_retriable',
    match: { code: 'COMMAND_FAILED', details: 'retriable' },
    verdicts: { retryable: true },
  },
  {
    reason: 'xcodebuild_exited_early',
    match: { code: 'COMMAND_FAILED', messageIncludesAll: ['xcodebuild exited early'] },
    verdicts: { retryable: false, connectRetry: false },
  },
  {
    reason: 'device_busy_connecting',
    match: { code: 'COMMAND_FAILED', messageIncludesAll: ['device is busy', 'connecting'] },
    verdicts: { retryable: false },
  },
  {
    reason: 'runner_connect_refused',
    match: { code: 'COMMAND_FAILED', messageIncludesAll: ['runner did not accept connection'] },
    verdicts: { retryable: true, restartBeforeSend: true },
  },
  {
    reason: 'fetch_failed',
    match: { code: 'COMMAND_FAILED', messageIncludesAll: ['fetch failed'] },
    verdicts: { retryable: true },
  },
  {
    reason: 'econnrefused',
    match: { code: 'COMMAND_FAILED', messageIncludesAll: ['econnrefused'] },
    verdicts: { retryable: true },
  },
  {
    reason: 'socket_hang_up',
    match: { code: 'COMMAND_FAILED', messageIncludesAll: ['socket hang up'] },
    verdicts: { retryable: true },
  },
  {
    reason: 'ax_snapshot_failure',
    match: { code: 'IOS_AX_SNAPSHOT_FAILED' },
    verdicts: { sessionFatalReason: 'ax_snapshot_failure' },
  },
  {
    reason: 'xctest_recorded_failure',
    match: { code: 'XCTEST_RECORDED_FAILURE' },
    verdicts: { sessionFatalReason: 'xctest_recorded_failure' },
  },
  {
    // The runner reported its main thread stuck in abandoned work past the wedge
    // threshold (#1105): only a restart cures it. The per-request recycle budget
    // still bounds how many boots one request pays for.
    reason: 'runner_main_thread_wedged',
    match: { code: 'RUNNER_WEDGED' },
    verdicts: { sessionFatalReason: 'runner_main_thread_wedged' },
  },
];

function matchesRunnerErrorRule(error: AppError, match: RunnerErrorMatch): boolean {
  if (match.code !== undefined && error.code !== match.code) return false;
  if (!matchesRunnerErrorDetails(error, match.details)) return false;
  return matchesRunnerErrorMessage(error, match.messageIncludesAll);
}

function matchesRunnerErrorDetails(error: AppError, details: RunnerErrorMatch['details']): boolean {
  if (details === undefined) return true;
  if (details === 'retriable') return error.details?.retriable === true;
  return isUsbmuxDeviceUnattachedError(error);
}

function matchesRunnerErrorMessage(error: AppError, parts: readonly string[] | undefined): boolean {
  if (!parts) return true;
  const message = `${error.message ?? ''}`.toLowerCase();
  return parts.every((part) => message.includes(part));
}

function runnerErrorVerdict<Axis extends keyof RunnerErrorVerdicts>(
  error: unknown,
  axis: Axis,
): RunnerErrorVerdicts[Axis] | undefined {
  if (!(error instanceof AppError)) return undefined;
  for (const rule of RUNNER_ERROR_RULES) {
    if (rule.verdicts[axis] === undefined) continue;
    if (matchesRunnerErrorRule(error, rule.match)) return rule.verdicts[axis];
  }
  return undefined;
}

export function isRetryableRunnerError(err: unknown): boolean {
  if (!(err instanceof AppError)) return false;
  if (err.code !== 'COMMAND_FAILED') return false;
  return runnerErrorVerdict(err, 'retryable') ?? false;
}

/**
 * True when usbmuxd answered and the device is simply not attached by cable.
 * A CoreDevice-backed device falls back to its network tunnel; an XCTest-backed
 * device has no second route, so this verdict is terminal rather than retryable.
 *
 * Lives here rather than beside the usbmux transport because the retry policy
 * below needs it, and that transport already depends on this module.
 */
export function isUsbmuxDeviceUnattachedError(error: unknown): boolean {
  if (!(error instanceof AppError) || error.code !== 'DEVICE_NOT_FOUND') return false;
  return (
    (error.details as { usbmuxDeviceAttached?: unknown } | undefined)?.usbmuxDeviceAttached ===
    false
  );
}

export function shouldRetryRunnerConnectError(error: unknown): boolean {
  return runnerErrorVerdict(error, 'connectRetry') ?? true;
}

/**
 * Session-fatal classification for a runner response error: when defined, the
 * cached runner session must be invalidated with this reason instead of being
 * reused (see ADR 0005 and docs/agents/selector-capture.md's
 * runnerFatal rule).
 */
export function resolveRunnerFatalErrorReason(error: unknown): string | undefined {
  return runnerErrorVerdict(error, 'sessionFatalReason');
}

/**
 * A connect-shaped failure that surfaced before the command was sent: restart
 * the runner session and replay the command, rather than probing a runner
 * that never accepted the connection. Composed with the connect-retry axis so
 * a terminal connect verdict (cable unattached, xcodebuild exited early)
 * still refuses the restart. Matching is table-driven and therefore
 * case-insensitive, unlike the raw-message check it replaced; the message is
 * our own transport literal, so no real error changes class.
 */
export function shouldRestartRunnerBeforeCommandSend(error: unknown): boolean {
  return (
    (runnerErrorVerdict(error, 'restartBeforeSend') ?? false) &&
    shouldRetryRunnerConnectError(error)
  );
}

export function resolveRunnerEarlyExitHint(
  message: string,
  stdout: string,
  stderr: string,
  reason?: BootFailureReason,
): string {
  const haystack = `${message}\n${stdout}\n${stderr}`.toLowerCase();
  if (haystack.includes('device is busy') && haystack.includes('connecting')) {
    return 'Target iOS device is still connecting. Keep it unlocked, wait for device trust/connection to settle, then retry.';
  }
  const classified = reason ?? 'IOS_RUNNER_CONNECT_TIMEOUT';
  // Clearing cached build products cannot put a device into a provisioning
  // profile, so that recovery advice is withheld where it would only add noise
  // to an already actionable instruction.
  if (classified === 'IOS_RUNNER_DEVICE_NOT_PROVISIONED') return bootFailureHint(classified);
  return `${bootFailureHint(classified)} ${RUNNER_CACHE_RECOVERY_HINT}`;
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
  // exec-guard-allow: xcodebuild can exit 0 and still count as an early exit;
  // the trio is nested tool context under `xcodebuild`, classified into
  // `reason`/`hint` above — not a process-exit wrap.
  return new AppError('COMMAND_FAILED', message, {
    port,
    logPath,
    xcodebuild: {
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
    },
    reason,
    hint: resolveRunnerEarlyExitHint(message, result.stdout, result.stderr, reason),
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
