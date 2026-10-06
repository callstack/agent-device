import type { CommandFlags } from '@agent-device/contracts/command';
import type { AndroidObservationAdapter } from '@agent-device/contracts/android-observation';
import type { GestureReferenceFrame } from '@agent-device/contracts/scroll-gesture';
import { emitDiagnostic } from '@agent-device/host-kit/diagnostics';
import type { SessionStore } from '../../session-store.ts';
import { getSnapshotReferenceFrame } from '@agent-device/capture-kit/touch-reference-frame';
import type { SessionRef } from '../../session-state.ts';
import type { BoundContextFromFlags, CaptureSnapshotForSession } from './types.ts';
import { isActiveProviderDevice } from '../../provider-device-admission.ts';

async function resolveDirectTouchReferenceFrame(params: {
  ref: SessionRef;
  flags: CommandFlags | undefined;
  sessionStore: SessionStore;
  contextFromFlags: BoundContextFromFlags;
  captureSnapshotForSession: CaptureSnapshotForSession;
  observation?: AndroidObservationAdapter;
}): Promise<GestureReferenceFrame | undefined> {
  const { ref, flags, sessionStore, contextFromFlags, captureSnapshotForSession, observation } =
    params;
  const session = sessionStore.resolveCurrent(ref);
  if (!session) return undefined;
  const resource = session.screenRecording;
  if (!resource) {
    return undefined;
  }
  const recording = resource.handle;
  const rememberFrame = (frame: GestureReferenceFrame | undefined) => {
    if (!frame || sessionStore.resolveCurrent(ref)?.screenRecording !== resource) return undefined;
    recording.setTouchReferenceFrame(frame);
    return frame;
  };
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
    return rememberFrame({
      referenceWidth: size.width,
      referenceHeight: size.height,
    });
  }

  const snapshotFrame = getSnapshotReferenceFrame(session.snapshot);
  if (snapshotFrame) {
    return rememberFrame(snapshotFrame);
  }

  const snapshot = await captureSnapshotForSession(ref, flags, sessionStore, contextFromFlags, {
    interactiveOnly: true,
  });
  return rememberFrame(getSnapshotReferenceFrame(snapshot));
}

export async function resolveDirectTouchReferenceFrameSafely(params: {
  ref: SessionRef;
  flags: CommandFlags | undefined;
  sessionStore: SessionStore;
  contextFromFlags: BoundContextFromFlags;
  captureSnapshotForSession: CaptureSnapshotForSession;
  observation?: AndroidObservationAdapter;
}): Promise<GestureReferenceFrame | undefined> {
  try {
    return await resolveDirectTouchReferenceFrame(params);
  } catch (error) {
    const current = params.sessionStore.resolveCurrent(params.ref);
    if (!current) return undefined;
    emitDiagnostic({
      level: 'warn',
      phase: 'touch_reference_frame_resolve_failed',
      data: {
        platform: current.device.platform,
        error: error instanceof Error ? error.message : String(error),
      },
    });
    return undefined;
  }
}
