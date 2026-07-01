import { isIosFamily } from '../kernel/device.ts';
import { getRunnerSessionSnapshot } from '../platforms/apple/core/runner/runner-client.ts';
import type { SessionState } from './types.ts';

export function refreshRecordingHealth(session: SessionState): void {
  if (!recordingRequiresRunnerHealth(session)) {
    return;
  }
  const recording = session.recording!;

  const snapshot = getRunnerSessionSnapshot(session.device.id);
  if (!recording.runnerSessionId) {
    if (snapshot?.alive) {
      recording.runnerSessionId = snapshot.sessionId;
    }
    return;
  }

  if (!snapshot?.alive) {
    recording.invalidatedReason ??= 'iOS runner session exited during recording';
    return;
  }

  if (snapshot.sessionId !== recording.runnerSessionId) {
    recording.invalidatedReason ??= 'iOS runner session restarted during recording';
  }
}

function recordingRequiresRunnerHealth(session: SessionState): boolean {
  const recording = session.recording;
  if (!recording || !isIosFamily(session.device)) return false;
  if (recording.platform === 'ios') return false;
  return recording.showTouches !== false;
}
