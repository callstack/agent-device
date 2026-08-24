/**
 * Commands that run OVER a live automation-helper session: snapshot capture and the touch commands
 * that piggyback on it. Session ownership itself — starting, reusing, retiring — belongs to
 * `snapshot-helper-session-lifecycle.ts`, which this module acquires through.
 */
import { AppError } from '@agent-device/kernel/errors';
import { emitDiagnostic } from '../../utils/diagnostics.ts';
import { readAndroidCaptureFailureReason } from '@agent-device/contracts/android-snapshot-quality';
import type {
  AndroidSnapshotHelperCaptureOptions,
  AndroidSnapshotHelperOutput,
} from './snapshot-helper-types.ts';
import type { AndroidSnapshotHelperResolvedCaptureOptions } from './snapshot-helper-capture.ts';
import {
  assertAndroidSnapshotHelperTouchSessionHeaders,
  parseAndroidSnapshotHelperSessionHeaders,
  requestAndroidSnapshotHelperSessionSnapshot,
  sendAndroidSnapshotHelperSessionCommand,
} from './snapshot-helper-session-protocol.ts';
import {
  acquireAndroidSnapshotHelperSession,
  getLiveAndroidSnapshotHelperSession,
  stopAndroidSnapshotHelperSession,
  type AndroidSnapshotHelperSession,
  type AndroidSnapshotHelperSessionHelperIdentity,
} from './snapshot-helper-session-lifecycle.ts';

export async function captureAndroidSnapshotWithHelperSession(
  options: AndroidSnapshotHelperCaptureOptions,
): Promise<AndroidSnapshotHelperOutput | undefined> {
  const acquired = await acquireAndroidSnapshotHelperSession(options);
  if (!acquired) return undefined;
  return await captureFromAndroidSnapshotHelperSession({
    session: acquired.session,
    deviceKey: acquired.deviceKey,
    options,
    resolved: acquired.resolved,
  });
}

async function captureFromAndroidSnapshotHelperSession(params: {
  session: AndroidSnapshotHelperSession;
  deviceKey: string;
  options: AndroidSnapshotHelperCaptureOptions;
  resolved: AndroidSnapshotHelperResolvedCaptureOptions;
}): Promise<AndroidSnapshotHelperOutput | undefined> {
  const { session, deviceKey, options, resolved } = params;
  try {
    const reused = session.capturedCount > 0;
    const output = await requestAndroidSnapshotHelperSessionSnapshot({
      port: session.port,
      timeoutMs: resolved.timeoutMs,
      commandTimeoutMs: resolved.commandTimeoutMs,
      signal: options.signal,
    });
    session.capturedCount += 1;
    return {
      xml: output.xml,
      metadata: {
        ...output.metadata,
        transport: 'persistent-session',
        sessionReused: reused,
      },
    };
  } catch (error) {
    await stopAndroidSnapshotHelperSession(deviceKey, {
      force: true,
      signal: options.signal,
      cause: error,
    });
    options.signal?.throwIfAborted();
    emitDiagnostic({
      level: 'warn',
      phase: 'android_snapshot_helper_session_fallback',
      data: {
        deviceKey,
        reason: error instanceof Error ? error.message : String(error),
        // The typed reason the session protocol already published, not a second
        // comparison against the helper's error type: one owner, one taxonomy (#1983).
        uiAutomationConnectionTimeout:
          readAndroidCaptureFailureReason(error) === 'accessibility-timeout',
      },
    });
    return undefined;
  }
}

// Touch commands piggyback on a live snapshot session so gestures do not restart instrumentation
// (Android permits one UiAutomation owner). They never start a session: without one, callers use
// the same helper APK through a one-shot `am instrument` run instead.
export async function runAndroidSnapshotHelperSessionTouchCommand(params: {
  deviceKey: string;
  action: 'gesture' | 'viewport';
  helper: AndroidSnapshotHelperSessionHelperIdentity;
  payloadBase64?: string;
  timeoutMs: number;
}): Promise<Record<string, string> | undefined> {
  const session = getLiveAndroidSnapshotHelperSession(params.deviceKey);
  if (!session) return undefined;
  if (!matchesSessionHelperIdentity(session.helper, params.helper)) {
    // A different helper binary was selected for this device (e.g. a provider-supplied artifact).
    // The live session belongs to the previous helper, so stop it and let the touch command run
    // one-shot against the selected artifact; the next snapshot restarts the session with it.
    emitDiagnostic({
      level: 'warn',
      phase: 'android_snapshot_helper_session_touch_identity_mismatch',
      data: {
        deviceKey: params.deviceKey,
        sessionHelper: session.helper,
        requestedHelper: params.helper,
      },
    });
    await stopAndroidSnapshotHelperSession(params.deviceKey);
    return undefined;
  }
  const requestId = `${params.action}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const command = params.payloadBase64
    ? `${params.action} ${requestId} ${params.payloadBase64}`
    : `${params.action} ${requestId}`;
  let headers: Record<string, string>;
  try {
    const response = await sendAndroidSnapshotHelperSessionCommand(
      session.port,
      command,
      params.timeoutMs,
    );
    headers = parseAndroidSnapshotHelperSessionHeaders(response);
    assertAndroidSnapshotHelperTouchSessionHeaders(headers, requestId);
  } catch (error) {
    // Transport-level failure: the session process can no longer be trusted. Stop it so the next
    // command runs against a fresh helper instead of a wedged socket.
    await stopAndroidSnapshotHelperSession(params.deviceKey);
    throw error;
  }
  if (headers.ok !== 'true') {
    // The helper ran and reported a structured failure; the session itself stays healthy.
    throw new AppError(
      'COMMAND_FAILED',
      headers.message || headers.errorType || `Android automation helper ${params.action} failed`,
      { errorType: headers.errorType, helper: headers },
    );
  }
  return headers;
}

function matchesSessionHelperIdentity(
  session: AndroidSnapshotHelperSessionHelperIdentity,
  requested: AndroidSnapshotHelperSessionHelperIdentity,
): boolean {
  return (
    session.packageName === requested.packageName &&
    session.runner === requested.runner &&
    matchesWhenBothDefined(session.helperVersion, requested.helperVersion) &&
    matchesWhenBothDefined(session.helperVersionCode, requested.helperVersionCode) &&
    matchesWhenBothDefined(session.sha256, requested.sha256)
  );
}

function matchesWhenBothDefined<Value>(a: Value | undefined, b: Value | undefined): boolean {
  return a === undefined || b === undefined || a === b;
}
