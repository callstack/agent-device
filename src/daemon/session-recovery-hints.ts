import type { SessionState } from './types.ts';
import { shellQuoteIfNeeded } from '../utils/shell-quote.ts';

export type SessionRecoveryContext = 'device-in-use' | 'selector-conflict';

export function describeSessionDevice(session: SessionState): string {
  const platform = session.device.platform;
  const name = session.device.name.trim();
  const id = session.device.id;
  return `${platform} device "${name}" (${id})`;
}

export function buildSessionRecoveryHint(
  session: SessionState,
  context: SessionRecoveryContext,
): string {
  // Active recording state controls user recovery text; record-only ownership controls cleanup.
  if (session.screenRecording) {
    return buildRecordingSessionRecoveryHint(session, context);
  }
  return buildOpenSessionRecoveryHint(session, context);
}

function buildRecordingSessionRecoveryHint(
  session: SessionState,
  context: SessionRecoveryContext,
): string {
  const sessionArg = shellQuoteIfNeeded(session.name);
  const closeCommand = `agent-device close --session ${sessionArg}`;
  const recordStopCommand = `agent-device record stop --session ${sessionArg}`;
  const reuseText =
    context === 'selector-conflict'
      ? `To keep using this device, rerun the command with --session ${sessionArg} and remove conflicting device selectors.`
      : `To keep using this device, reuse --session ${sessionArg} for commands that should attach to the recording session.`;

  return (
    `Recording session "${session.name}" owns this device. ` +
    `Run ${recordStopCommand}; if the session still appears in agent-device session list, run ${closeCommand}. ` +
    `${reuseText} ` +
    `Run agent-device session list to inspect active sessions.`
  );
}

function buildOpenSessionRecoveryHint(
  session: SessionState,
  context: SessionRecoveryContext,
): string {
  const sessionArg = shellQuoteIfNeeded(session.name);
  const closeCommand = `agent-device close --session ${sessionArg}`;
  if (context === 'selector-conflict') {
    return (
      `Run agent-device session list to inspect active sessions. ` +
      `To reuse this device, rerun the command with --session ${sessionArg} and remove conflicting device selectors. ` +
      `To switch devices, first run ${closeCommand}, then open the desired device with a different --session name.`
    );
  }

  return (
    `Run agent-device session list to inspect active sessions. ` +
    `To reuse this device, rerun the command with --session ${sessionArg}. ` +
    `To open a new session on this device, first run ${closeCommand}.`
  );
}
