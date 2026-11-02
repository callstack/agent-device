import type { DaemonFailureResponse, DaemonResponse } from '@agent-device/kernel/contracts';
import type { AppleApplicationState } from '@agent-device/kernel/snapshot';
import {
  isApplePlatform,
  isMacOs,
  isIosFamily,
  publicPlatformString,
  type DeviceInfo,
  type PlatformSelector,
} from '@agent-device/kernel/device';
import type { SessionSurface } from '@agent-device/contracts/session';
import { errorResponse } from '@agent-device/kernel/contracts';
import { namedSessionNotFoundDetails } from '@agent-device/kernel/errors';
import { appStateUse } from '@agent-device/contracts/platform-runtime-operations';
import { admitRuntimeUse } from '../../core/runtime-admission.ts';
import type { RuntimeCommandHandlerParams } from '../../core/session-runtime-admission.ts';

/**
 * The session facts this answer is built from, as a structural view: the handler reads exactly
 * the fields it uses and passes no more of the session shape than this.
 */
export type AppStateSessionRecord = Readonly<{
  device: DeviceInfo;
  surface?: SessionSurface;
  appBundleId?: string;
  appName?: string;
}>;

const IOS_APPSTATE_SESSION_REQUIRED_MESSAGE =
  'iOS appstate requires an active session on the target device. Run open first (for example: open --session sim --platform ios --device "<name>" <app>).';
const MACOS_APPSTATE_SESSION_REQUIRED_MESSAGE =
  'macOS appstate requires an active session on the target device. Run open first (for example: open --session macos --platform macos "System Settings").';

/**
 * The refusal for an appstate whose session the daemon does not hold. Every Apple selector —
 * `apple`, `ios`, or `macos` — answers appstate only from an open session and its runner, so the
 * "omit --session" route they would otherwise be pointed at just reaches the session-required
 * refusal. Send them straight to opening the session.
 */
export function appStateSessionNotFoundResponse(
  sessionName: string,
  platform: PlatformSelector | undefined,
): DaemonResponse {
  if (isApplePlatform(platform)) {
    return errorResponse(
      'SESSION_NOT_FOUND',
      `No active session "${sessionName}". Run open with --session ${sessionName} first.`,
      namedSessionNotFoundDetails(sessionName),
    );
  }
  return errorResponse(
    'SESSION_NOT_FOUND',
    `No active session "${sessionName}". Run open with --session ${sessionName} first, or omit --session to query by device selector.`,
    namedSessionNotFoundDetails(sessionName),
  );
}

/**
 * Apple platforms answer appstate from a session and its runner, never from a bare device query:
 * this is the refusal for a request whose Apple target has no session to read.
 */
export function appleSessionRequiredRefusal(platform: 'ios' | 'macos'): DaemonResponse {
  return errorResponse(
    'SESSION_NOT_FOUND',
    platform === 'macos'
      ? MACOS_APPSTATE_SESSION_REQUIRED_MESSAGE
      : IOS_APPSTATE_SESSION_REQUIRED_MESSAGE,
  );
}

/** The owner has no live session for the device, so the session record must not answer for it. */
export function ownerHoldsNoLiveSession(reason: unknown): boolean {
  return reason === 'owner-capability-missing';
}

type AppleAppStateRead =
  | Readonly<{ state?: AppleApplicationState }>
  | Readonly<{ refusal: DaemonFailureResponse }>;

/**
 * What a live read says about the session app. An owner with no live read for this kind of device
 * leaves the session record to answer, and one with no live session for this device refuses, so the
 * record never answers for a device that is gone. A read that fails throws for the same reason. The
 * owner never starts a runner for it.
 */
async function readAppleSessionAppState(
  params: RuntimeCommandHandlerParams,
  session: Readonly<{ device: DeviceInfo; appBundleId?: string }>,
): Promise<AppleAppStateRead> {
  const admitted = await admitRuntimeUse({
    command: 'appstate',
    device: session.device,
    use: appStateUse,
    inspectFacts: params.inspectFacts,
    platformServices: params.platformServices,
    bindDevice: params.bindDevice,
  });
  if (admitted.type === 'response') {
    return ownerHoldsNoLiveSession(admitted.response.error.details?.reason)
      ? { refusal: admitted.response }
      : {};
  }
  const read = await admitted.runtime.operations.appState({ appBundleId: session.appBundleId });
  return { state: read.applicationState };
}

/** A macOS desktop surface (not an app session) is answered from the session record alone. */
function desktopSurfaceResponse(session: AppStateSessionRecord): DaemonResponse | undefined {
  if (!isMacOs(session.device) || !session.surface) return undefined;
  if (session.surface === 'app' || session.surface === 'frontmost-app') return undefined;
  return {
    ok: true,
    data: {
      platform: publicPlatformString(session.device),
      appName: session.surface,
      appBundleId: session.appBundleId,
      source: 'session',
      surface: session.surface,
    },
  };
}

/**
 * What this Apple session currently hosts: the tracked app's live runner state when the owner
 * admits a read and has one, otherwise the session record itself. A session with no tracked
 * foreground app says so instead of inventing one.
 */
export async function appleSessionAppStateResponse(
  params: RuntimeCommandHandlerParams,
  session: AppStateSessionRecord,
): Promise<DaemonResponse> {
  if (!session.appName && !session.appBundleId) {
    const surface = desktopSurfaceResponse(session);
    if (surface) return surface;
    const sessionPlatform = isMacOs(session.device) ? 'macOS' : 'iOS';
    return errorResponse(
      'COMMAND_FAILED',
      `No foreground app is tracked for this ${sessionPlatform} session. Open an app in the session, then retry appstate.`,
    );
  }

  const read = await readAppleSessionAppState(params, session);
  if ('refusal' in read) return read.refusal;
  const { state } = read;
  const appName = session.appName ?? session.appBundleId;
  return {
    ok: true,
    data: {
      platform: publicPlatformString(session.device),
      appName: appName ?? 'unknown',
      appBundleId: session.appBundleId,
      source: state ? 'runner' : 'session',
      ...(state ? { state } : {}),
      surface: session.surface ?? 'app',
      ...(isIosFamily(session.device)
        ? {
            device_udid: session.device.id,
            ios_simulator_device_set: session.device.simulatorSetPath ?? null,
          }
        : {}),
    },
  };
}
