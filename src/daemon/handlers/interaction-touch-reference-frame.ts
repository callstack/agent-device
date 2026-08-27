import type { CommandFlags } from '@agent-device/contracts/command';
import type { AndroidObservationAdapter } from '@agent-device/contracts/android-observation';
import type { GestureReferenceFrame } from '@agent-device/contracts/scroll-gesture';
import type { SnapshotNode } from '@agent-device/kernel/snapshot';
import { emitDiagnostic } from '../../utils/diagnostics.ts';
import type { SessionStore } from '../session-store.ts';
import { getSnapshotReferenceFrame } from '../touch-reference-frame.ts';
import type { SessionState } from '../types.ts';
import type { ContextFromFlags } from './interaction-common.ts';
import type { CaptureSnapshotForSession } from './interaction-snapshot.ts';
import { isActiveProviderDevice } from '../../provider-device-runtime.ts';

async function resolveDirectTouchReferenceFrame(params: {
  session: SessionState;
  flags: CommandFlags | undefined;
  sessionStore: SessionStore;
  contextFromFlags: ContextFromFlags;
  captureSnapshotForSession: CaptureSnapshotForSession;
  observation?: AndroidObservationAdapter;
}): Promise<GestureReferenceFrame | undefined> {
  const { session, flags, sessionStore, contextFromFlags, captureSnapshotForSession, observation } =
    params;
  const recording = session.screenRecording?.handle;
  if (!recording) {
    return undefined;
  }
  const currentFrame = recording.inspect().touchReferenceFrame;
  if (currentFrame) {
    return currentFrame;
  }

  if (
    session.device.platform === 'android' &&
    !session.lease?.leaseProvider &&
    !isActiveProviderDevice(session.device)
  ) {
    if (!observation) throw new Error('Android observation was not injected into the request');
    const size = await observation.readScreenSize(session.device);
    const referenceFrame = {
      referenceWidth: size.width,
      referenceHeight: size.height,
    };
    recording.setTouchReferenceFrame(referenceFrame);
    return referenceFrame;
  }

  const snapshotFrame = getSnapshotReferenceFrame(session.snapshot);
  if (snapshotFrame) {
    recording.setTouchReferenceFrame(snapshotFrame);
    return snapshotFrame;
  }

  const snapshot = await captureSnapshotForSession(session, flags, sessionStore, contextFromFlags, {
    interactiveOnly: true,
  });
  const referenceFrame = getSnapshotReferenceFrame(snapshot);
  if (referenceFrame) recording.setTouchReferenceFrame(referenceFrame);
  return referenceFrame;
}

export async function resolveDirectTouchReferenceFrameSafely(params: {
  session: SessionState;
  flags: CommandFlags | undefined;
  sessionStore: SessionStore;
  contextFromFlags: ContextFromFlags;
  captureSnapshotForSession: CaptureSnapshotForSession;
  observation?: AndroidObservationAdapter;
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
