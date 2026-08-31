import type { DeviceInfo } from '@agent-device/kernel/device';
import { shellQuoteIfNeeded } from '@agent-device/host-kit/command';
import type { DaemonResponse, SessionRef, SessionState } from './types.ts';
import { errorResponse } from './response.ts';

export type SessionRecoveryContext = 'device-in-use' | 'selector-conflict';

export function describeSessionDevice(session: SessionState): string {
  const platform = session.device.platform;
  const name = session.device.name.trim();
  const id = session.device.id;
  return `${platform} device "${name}" (${id})`;
}

/**
 * Every command in a recovery hint is addressed by `ref.address`, never by `SessionState.name`:
 * the hint's whole job is to hand back a command that runs, and for an implicitly cwd-scoped
 * session those two differ (see {@link SessionRef}). Taking the pair rather than a record is what
 * keeps an addressless caller from compiling.
 */
export function buildSessionRecoveryHint(ref: SessionRef, context: SessionRecoveryContext): string {
  // Active recording state controls user recovery text; record-only ownership controls cleanup.
  if (ref.session.screenRecording) {
    return buildRecordingSessionRecoveryHint(ref.address, context);
  }
  return buildOpenSessionRecoveryHint(ref.address, context);
}

export function buildDeviceInUseBySessionError(
  inUse: SessionRef,
  device: DeviceInfo,
): DaemonResponse {
  return errorResponse('DEVICE_IN_USE', `Device is already in use by session "${inUse.address}".`, {
    session: inUse.address,
    deviceId: device.id,
    deviceName: device.name,
    hint: buildSessionRecoveryHint(inUse, 'device-in-use'),
  });
}

function buildRecordingSessionRecoveryHint(
  sessionAddress: string,
  context: SessionRecoveryContext,
): string {
  const sessionArg = shellQuoteIfNeeded(sessionAddress);
  const closeCommand = `agent-device close --session ${sessionArg}`;
  const recordStopCommand = `agent-device record stop --session ${sessionArg}`;
  const reuseText =
    context === 'selector-conflict'
      ? `To keep using this device, rerun the command with --session ${sessionArg} and remove conflicting device selectors.`
      : `To keep using this device, reuse --session ${sessionArg} for commands that should attach to the recording session.`;

  return (
    `Recording session "${sessionAddress}" owns this device. ` +
    `Run ${recordStopCommand}; if the session still appears in agent-device session list, run ${closeCommand}. ` +
    `${reuseText} ` +
    `Run agent-device session list to inspect active sessions.`
  );
}

function buildOpenSessionRecoveryHint(
  sessionAddress: string,
  context: SessionRecoveryContext,
): string {
  const sessionArg = shellQuoteIfNeeded(sessionAddress);
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
