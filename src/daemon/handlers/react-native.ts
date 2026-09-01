import {
  createBoundTouchExecutor,
  resolveBoundTouchRuntime,
  type BoundTouchRuntime,
} from '../touch-runtime.ts';
import { PUBLIC_COMMANDS } from '../../command-catalog.ts';
import {
  analyzeReactNativeOverlay,
  type ReactNativeOverlayDismissTarget,
} from '../../core/react-native-overlay.ts';
import { normalizeError } from '@agent-device/kernel/errors';
import { stripUndefined } from '@agent-device/kernel/record';
import { successText } from '@agent-device/kernel/success-text';

import type { SnapshotQualityVerdict, SnapshotState } from '@agent-device/kernel/snapshot';
import { isSparseSnapshotQualityVerdict } from '@agent-device/capture-kit/snapshot-quality-verdict';
import type { DaemonResponse, SessionState } from '../types.ts';
import { errorResponse, noActiveSessionError } from '../response.ts';
import {
  captureSnapshotForSession,
  finalizeTouchInteraction,
  type InteractionRouteInput,
} from '../interaction/index.ts';
import { expireRefFrame } from '../ref-frame.ts';
import { readSnapshotNodesReferenceFrame } from '../touch-reference-frame.ts';

export async function handleReactNativeCommands(
  params: InteractionRouteInput,
): Promise<DaemonResponse | null> {
  const { req, sessionName, sessionStore } = params;
  if (req.command !== PUBLIC_COMMANDS.reactNative) return null;
  const parsed = parseReactNativeArgs(req.positionals ?? []);
  if (!parsed.ok) return parsed.response;

  const session = sessionStore.get(sessionName);
  if (!session) return noActiveSessionError();
  // R61: admission is the owner's own `tapPoint` fact — the one operation this command executes.
  // It runs before the observing capture, exactly where the retired capability gate ran, so an
  // owner that cannot dismiss an overlay refuses without first spending a snapshot on it.
  //
  // Deliberate widening: the retired bucket was `{apple, android, linux: {}}`, so Linux desktop,
  // web and HarmonyOS were refused by family. All three admit `tapPoint`, so all three now run —
  // and answer `detected: false` on a surface with no React Native overlay, which is the truthful
  // result. A family cannot be a support authority for a migrated command (ADR 0019 §8); the
  // Linux and web coverage manifests record this, and HarmonyOS has no manifest to record it in.
  const bound = await resolveBoundTouchRuntime({
    device: session.device,
    command: 'press',
    requiresCapture: false,
    inspectFacts: params.inspectFacts,
    bindDevice: params.bindDevice,
    unavailableResponse: (unavailable) =>
      errorResponse(
        'UNSUPPORTED_OPERATION',
        'react-native dismiss-overlay is not supported on this device',
        undefined,
        unavailable.hint ? { hint: unavailable.hint } : undefined,
      ),
  });
  if (!bound.ok) return bound.response;

  try {
    const snapshot = await captureSnapshotForSession(
      session,
      req.flags,
      sessionStore,
      params.contextFromFlags,
      { interactiveOnly: true },
    );
    if (isSparseSnapshotQualityVerdict(snapshot.snapshotQuality)) {
      return responseForSparseReactNativeOverlaySnapshot(snapshot.snapshotQuality);
    }
    const overlay = analyzeReactNativeOverlay(snapshot.nodes);
    const target = overlay.primaryAction;
    if (!target) {
      return responseForMissingReactNativeOverlayTarget(overlay.detected);
    }
    return await executeReactNativeOverlayDismiss(params, session, snapshot, target, bound.runtime);
  } catch (error) {
    return { ok: false, error: normalizeError(error) };
  }
}

function parseReactNativeArgs(
  positionals: string[],
): { ok: true } | { ok: false; response: DaemonResponse } {
  if (positionals.length === 1 && positionals[0] === 'dismiss-overlay') {
    return { ok: true };
  }
  return {
    ok: false,
    response: errorResponse('INVALID_ARGS', 'react-native supports only: dismiss-overlay'),
  };
}

function responseForMissingReactNativeOverlayTarget(overlayDetected: boolean): DaemonResponse {
  if (!overlayDetected) {
    return {
      ok: true,
      data: {
        action: 'dismiss-overlay',
        detected: false,
        dismissed: false,
        ...successText('No React Native overlay detected'),
      },
    };
  }
  return errorResponse(
    'COMMAND_FAILED',
    'React Native overlay detected, but no safe dismiss target was found',
    {
      hint: 'Use screenshot --overlay-refs for visual evidence and report the overlay instead of pressing the warning body.',
    },
  );
}

function responseForSparseReactNativeOverlaySnapshot(
  verdict: SnapshotQualityVerdict,
): DaemonResponse {
  return errorResponse(
    'COMMAND_FAILED',
    'React Native overlay state could not be determined because the accessibility tree is unreadable',
    {
      reason: verdict.reason,
      hint: 'The snapshot quality verdict is sparse. Use screenshot as visual truth; if an overlay is visible, report it or navigate with coordinates, then retry snapshot or dismiss-overlay on a readable screen.',
    },
  );
}

/**
 * R61 renamed this from `dismissReactNativeOverlayTarget` to record the contract change: it no
 * longer resolves anything, because admission moved up to the route entry. It receives an
 * already-bound runtime and executes the one tap.
 */
async function executeReactNativeOverlayDismiss(
  params: InteractionRouteInput,
  session: SessionState,
  snapshot: SnapshotState,
  target: ReactNativeOverlayDismissTarget,
  runtime: BoundTouchRuntime,
): Promise<DaemonResponse> {
  const { req, sessionStore } = params;
  // The dismissal press rides the same bound `tapPoint` a user-typed `press` does (R48). The
  // binding is the caller's: admission happened before the overlay was even observed.
  const context = params.contextFromFlags(req.flags, session.appBundleId, session.trace?.outPath);
  const executor = createBoundTouchExecutor(runtime, context);
  // `tapPoint` is this command's one *required* operation, so admission already proved the cell.
  // The executor still types every leg optional, and reaching it through `?.` would report
  // `dismissed: true` for a dismissal that never touched the device. Refuse instead of lying.
  const tapPoint = executor.tapPoint;
  if (!tapPoint) {
    return errorResponse(
      'UNSUPPORTED_OPERATION',
      'react-native dismiss-overlay is not supported on this device',
    );
  }
  const actionStartedAt = Date.now();
  // ADR 0014 side-effect seam: React Native overlay dismissal taps the device;
  // the target is already resolved, so expire the frame before the press.
  expireRefFrame(session);
  const data = await tapPoint(target.point);
  const actionFinishedAt = Date.now();
  const verification = await verifyReactNativeOverlayDismissal(params, session);
  const responseData = stripUndefined({
    ...readSnapshotNodesReferenceFrame(snapshot.nodes),
    ...data,
    action: 'dismiss-overlay',
    overlayAction: target.action,
    x: target.point.x,
    y: target.point.y,
    ref: target.ref,
    label: target.label,
    warning: target.warning,
    dismissed: true,
    verified: verification.verified,
    verificationRequired: !verification.verified,
    verificationWarning: verification.verificationWarning,
    nextCommand: verification.nextCommand,
    ...successText(formatDismissMessage(verification)),
  });
  return finalizeTouchInteraction({
    session,
    sessionStore,
    command: req.command,
    positionals: req.positionals ?? [],
    flags: req.flags,
    result: responseData,
    responseData,
    actionStartedAt,
    actionFinishedAt,
  });
}

async function verifyReactNativeOverlayDismissal(
  params: InteractionRouteInput,
  session: SessionState,
): Promise<{
  verified: boolean;
  verificationWarning?: string;
  nextCommand?: string;
}> {
  const { req, sessionStore } = params;
  const verificationSnapshot = await captureSnapshotForSession(
    session,
    req.flags,
    sessionStore,
    params.contextFromFlags,
    { interactiveOnly: true },
  );
  if (isSparseSnapshotQualityVerdict(verificationSnapshot.snapshotQuality)) {
    return {
      verified: false,
      verificationWarning:
        'React Native overlay dismissal could not be verified because the post-dismiss accessibility tree is unreadable. Use screenshot as visual truth.',
      nextCommand: 'agent-device screenshot',
    };
  }
  const overlay = analyzeReactNativeOverlay(verificationSnapshot.nodes);
  if (!overlay.detected) {
    return {
      verified: true,
    };
  }
  return {
    verified: false,
    verificationWarning:
      'React Native overlay is still detected after dismissal. Use screenshot --overlay-refs for visual evidence and report the overlay instead of pressing the warning body.',
    nextCommand: 'agent-device screenshot --overlay-refs',
  };
}

function formatDismissMessage(verification: { verified: boolean }): string {
  if (verification.verified) {
    return 'React Native overlay dismiss action sent and verified gone';
  }
  return 'React Native overlay dismiss action sent, but verification still detects an overlay';
}
