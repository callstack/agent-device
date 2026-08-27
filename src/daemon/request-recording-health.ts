import { isIosFamily } from '@agent-device/kernel/device';
import { inspectAppleRunnerSession } from '../platform-runtime-apple-resources.ts';
import type { SessionState } from './types.ts';

export async function refreshRecordingHealth(session: SessionState): Promise<void> {
  if (!recordingRequiresRunnerHealth(session)) {
    return;
  }
  const recording = session.screenRecording!.handle;
  const state = recording.inspect();

  const snapshot = await inspectAppleRunnerSession(session.device.id);
  if (!state.runnerSessionId) {
    if (snapshot?.alive) {
      recording.setRunnerSessionId(snapshot.sessionId);
    }
    return;
  }

  if (!snapshot?.alive) {
    recording.invalidate('iOS runner session exited during recording');
    return;
  }

  if (snapshot.sessionId !== state.runnerSessionId) {
    recording.invalidate('iOS runner session restarted during recording');
  }
}

function recordingRequiresRunnerHealth(session: SessionState): boolean {
  const recording = session.screenRecording?.handle.inspect();
  if (!recording || !isIosFamily(session.device)) return false;
  return recording.backend === 'runner AVAssetWriter' && recording.showTouches !== false;
}
