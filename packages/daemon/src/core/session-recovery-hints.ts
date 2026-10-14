import type { DeviceInfo } from '@agent-device/kernel/device';
import { shellQuoteIfNeeded } from '@agent-device/kernel/device-shell';
import type { SessionRef, SessionState } from './session-state.ts';
import { errorResponse, type DaemonFailureResponse } from '@agent-device/kernel/contracts';

export type SessionRecoveryContext = 'device-in-use' | 'selector-conflict';

export type SessionRecoveryOptions = {
  /** Whether the request disagrees with the bound session on *platform*, the one conflict another
   * platform's implicit session actually answers. */
  offersPlatformSession?: boolean;
  /**
   * Milliseconds an `open` already waited for the device under its `--wait` budget. Set only
   * once a budget was spent, and it flips the recovery text: a caller that waited is told the
   * wait happened, and one that did not is told waiting is an option.
   */
  waitedMs?: number;
  /**
   * Whether the refused command is one that can wait for a device at all. Only `open` carries
   * `--wait`, so only its refusal may offer it; an interaction refused mid-session is told to
   * reuse or close the owning session, which is what it can actually run.
   */
  offersDeviceWait?: boolean;
};

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
export function buildSessionRecoveryHint(
  ref: SessionRef,
  context: SessionRecoveryContext,
  options: SessionRecoveryOptions = {},
): string {
  // Active recording state controls user recovery text; record-only ownership controls cleanup.
  if (ref.session.screenRecording) {
    return buildRecordingSessionRecoveryHint(ref.address, context);
  }
  return buildOpenSessionRecoveryHint(ref, context, options);
}

export function buildDeviceInUseBySessionError(
  inUse: SessionRef,
  device: DeviceInfo,
  options: SessionRecoveryOptions = {},
): DaemonFailureResponse {
  return errorResponse('DEVICE_IN_USE', `Device is already in use by session "${inUse.address}".`, {
    session: inUse.address,
    deviceId: device.id,
    deviceName: device.name,
    ...(options.waitedMs === undefined ? {} : { waitedMs: options.waitedMs }),
    hint: buildSessionRecoveryHint(inUse, 'device-in-use', options),
  });
}

/**
 * The refusal an `open` gets when the device is held by another workspace's implicit session.
 * The address is named because it is the only handle that reaches that session: an implicit
 * workspace session is stored under `cwd:<hash>:default` while `session list` shows `default`,
 * so a hint that said only "another workspace" handed the caller nothing it could act on (#2580).
 */
export function buildForeignWorkspaceSessionConflict(
  inUse: SessionRef,
  device: DeviceInfo,
  options: SessionRecoveryOptions = {},
): DaemonFailureResponse {
  return errorResponse(
    'DEVICE_IN_USE',
    `Device is already in use by workspace session "${inUse.address}".`,
    {
      reason: 'WORKSPACE_SESSION_SCOPE_CONFLICT',
      session: inUse.address,
      deviceId: device.id,
      deviceName: device.name,
      ...(options.waitedMs === undefined ? {} : { waitedMs: options.waitedMs }),
      hint: buildForeignWorkspaceSessionRecoveryHint(inUse.address, options),
    },
  );
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

/**
 * The recovery text for the one session-in-use conflict the caller cannot simply join: the
 * holder is another workspace's implicit session. The address is still the whole point — it is
 * what `close --session` and `--session` take, and for an implicit session it is the store key
 * rather than the `default` name `session list` shows (#2031) — but reusing it would run this
 * workspace's commands inside the other workspace's session, so closing it, switching device, and
 * waiting are the moves offered.
 */
function buildForeignWorkspaceSessionRecoveryHint(
  sessionAddress: string,
  options: SessionRecoveryOptions,
): string {
  const sessionArg = shellQuoteIfNeeded(sessionAddress);
  return (
    `${describeOpenWaitAttempt(options)}Session "${sessionAddress}" belongs to another workspace. ` +
    `Run agent-device close --session ${sessionArg} to release this device from that workspace, ` +
    `agent-device devices to choose another device. ` +
    `${waitForDeviceHint(options)}Run agent-device session list to inspect active sessions.`
  );
}

function buildOpenSessionRecoveryHint(
  ref: SessionRef,
  context: SessionRecoveryContext,
  options: SessionRecoveryOptions,
): string {
  const sessionAddress = ref.address;
  const sessionArg = shellQuoteIfNeeded(sessionAddress);
  const closeCommand = `agent-device close --session ${sessionArg}`;
  if (context === 'selector-conflict') {
    return (
      `Run agent-device session list to inspect active sessions. ` +
      `To reuse this device, rerun the command with --session ${sessionArg} and remove conflicting device selectors. ` +
      `To switch devices, first run ${closeCommand}, then open the desired device with a different --session name.` +
      implicitPlatformSessionHint(ref, options)
    );
  }

  return (
    `${describeOpenWaitAttempt(options)}Run agent-device session list to inspect active sessions. ` +
    `To reuse this device, rerun the command with --session ${sessionArg}. ` +
    `To open a new session on this device, first run ${closeCommand}. ` +
    `${waitForDeviceHint(options)}`.trimEnd()
  );
}

/**
 * The record of a spent `--wait` budget, phrased so a caller that already waited is not told to
 * wait again. Only an `open` can wait, so this is the only place the budget is spoken of.
 */
function describeOpenWaitAttempt(options: SessionRecoveryOptions): string {
  return options.waitedMs === undefined
    ? ''
    : `Waited ${Math.round(options.waitedMs)}ms for this device and it stayed busy. `;
}

function waitForDeviceHint(options: SessionRecoveryOptions): string {
  return options.offersDeviceWait && options.waitedMs === undefined
    ? 'To wait for the device to free up, run the same open with --wait <ms>. '
    : '';
}

/**
 * An implicit workspace session is addressed by platform, so switching platforms needs no invented
 * session name (#2580). A session the caller named by hand has no platform address to fall back to,
 * so the suggestion is withheld there rather than offered as a dead end.
 */
function implicitPlatformSessionHint(ref: SessionRef, options: SessionRecoveryOptions): string {
  const offers = options.offersPlatformSession === true && ref.session.sessionScope?.kind === 'cwd';
  return offers
    ? ' Or name the other platform with --platform to open its own session for this workspace.'
    : '';
}
