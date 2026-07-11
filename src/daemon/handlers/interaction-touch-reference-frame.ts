import type { CommandFlags } from '../../core/dispatch.ts';
import type { GestureReferenceFrame } from '../../contracts/scroll-gesture.ts';
import type { SnapshotNode } from '../../kernel/snapshot.ts';
import { getAndroidScreenSize } from '../../platforms/android/input-actions.ts';
import { emitDiagnostic } from '../../utils/diagnostics.ts';
import type { SessionStore } from '../session-store.ts';
import { getSnapshotReferenceFrame } from '../touch-reference-frame.ts';
import type { SessionState } from '../types.ts';
import type { ContextFromFlags } from './interaction-common.ts';
import type { CaptureSnapshotForSession } from './interaction-snapshot.ts';

async function resolveDirectTouchReferenceFrame(params: {
  session: SessionState;
  flags: CommandFlags | undefined;
  sessionStore: SessionStore;
  contextFromFlags: ContextFromFlags;
  captureSnapshotForSession: CaptureSnapshotForSession;
}): Promise<GestureReferenceFrame | undefined> {
  const { session, flags, sessionStore, contextFromFlags, captureSnapshotForSession } = params;
  if (!session.recording) {
    return undefined;
  }
  if (session.recording.touchReferenceFrame) {
    return session.recording.touchReferenceFrame;
  }

  if (session.device.platform === 'android') {
    const size = await getAndroidScreenSize(session.device);
    const referenceFrame = {
      referenceWidth: size.width,
      referenceHeight: size.height,
    };
    if (session.recording) {
      session.recording.touchReferenceFrame = referenceFrame;
    }
    return referenceFrame;
  }

  const snapshotFrame = getSnapshotReferenceFrame(session.snapshot);
  if (snapshotFrame) {
    if (session.recording) {
      session.recording.touchReferenceFrame = snapshotFrame;
    }
    return snapshotFrame;
  }

  if (!session.recording) {
    return undefined;
  }

  const snapshot = await captureSnapshotForSession(session, flags, sessionStore, contextFromFlags, {
    interactiveOnly: true,
  });
  const referenceFrame = getSnapshotReferenceFrame(snapshot);
  if (referenceFrame && session.recording) {
    session.recording.touchReferenceFrame = referenceFrame;
  }
  return referenceFrame;
}

export async function resolveDirectTouchReferenceFrameSafely(params: {
  session: SessionState;
  flags: CommandFlags | undefined;
  sessionStore: SessionStore;
  contextFromFlags: ContextFromFlags;
  captureSnapshotForSession: CaptureSnapshotForSession;
}): Promise<GestureReferenceFrame | undefined> {
  try {
    return await resolveDirectTouchReferenceFrame(params);
  } catch (error) {
    emitDiagnostic({
      level: 'warn',
      phase: 'touch_reference_frame_resolve_failed',
      data: {
        platform: params.session.device.platform,
        error: error instanceof Error ? error.message : String(error),
      },
    });
    return undefined;
  }
}

export function readSnapshotNodesReferenceFrame(
  nodes: SnapshotNode[],
): GestureReferenceFrame | undefined {
  return getSnapshotReferenceFrame({
    nodes,
    createdAt: 0,
  });
}
