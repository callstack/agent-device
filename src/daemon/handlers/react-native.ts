import { dispatchCommand } from '../../core/dispatch.ts';
import { PUBLIC_COMMANDS } from '../../command-catalog.ts';
import {
  analyzeReactNativeOverlay,
  type ReactNativeOverlayDismissTarget,
} from '../../core/react-native-overlay.ts';
import { normalizeError } from '../../kernel/errors.ts';
import { stripUndefined } from '../../utils/parsing.ts';
import { successText } from '../../utils/success-text.ts';
import type { SnapshotState } from '../../kernel/snapshot.ts';
import {
  isSparseSnapshotQualityVerdict,
  type SnapshotQualityVerdict,
} from '../../snapshot/snapshot-quality.ts';
import type { DaemonResponse, SessionState } from '../types.ts';
import { errorResponse, noActiveSessionError, requireCommandSupported } from './response.ts';
import { captureSnapshotForSession } from './interaction-snapshot.ts';
import { finalizeTouchInteraction, type InteractionHandlerParams } from './interaction-common.ts';
import { readSnapshotNodesReferenceFrame } from './interaction-touch-reference-frame.ts';

export async function handleReactNativeCommands(
  params: InteractionHandlerParams,
): Promise<DaemonResponse | null> {
  const { req, sessionName, sessionStore } = params;
  if (req.command !== PUBLIC_COMMANDS.reactNative) return null;
  const parsed = parseReactNativeArgs(req.positionals ?? []);
  if (!parsed.ok) return parsed.response;

  const session = sessionStore.get(sessionName);
  if (!session) return noActiveSessionError();
  const unsupported = requireCommandSupported(PUBLIC_COMMANDS.reactNative, session.device, {
    message: 'react-native dismiss-overlay is not supported on this device',
  });
  if (unsupported) return unsupported;

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
    return await dismissReactNativeOverlayTarget(params, session, snapshot, target);
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

async function dismissReactNativeOverlayTarget(
  params: InteractionHandlerParams,
  session: SessionState,
  snapshot: SnapshotState,
  target: ReactNativeOverlayDismissTarget,
): Promise<DaemonResponse> {
  const { req, sessionStore } = params;
  const actionStartedAt = Date.now();
  const data =
    (await dispatchCommand(
      session.device,
      'press',
      [String(target.point.x), String(target.point.y)],
      req.flags?.out,
      params.contextFromFlags(req.flags, session.appBundleId, session.trace?.outPath),
    )) ?? {};
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
  params: InteractionHandlerParams,
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
