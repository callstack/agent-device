import type { DaemonResponse } from '@agent-device/kernel/contracts';
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
import {
  asAppError,
  isRequestCanceledError,
  namedSessionNotFoundDetails,
} from '@agent-device/kernel/errors';
import { emitDiagnostic } from '@agent-device/host-kit/diagnostics';
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

/**
 * The session app's state as a live runner reads it, when this device's owner admits the read;
 * nothing otherwise, so the session record alone answers and no state is invented. The owner never
 * starts a runner for it. A runner that cannot answer right now (busy, mid-restart) leaves the
 * session answer as it was and says so in the log; a cancelled request stays cancelled.
 */
async function readAppleSessionAppState(
  params: RuntimeCommandHandlerParams,
  session: Readonly<{ device: DeviceInfo; appBundleId?: string }>,
): Promise<AppleApplicationState | undefined> {
  if (!session.appBundleId) return undefined;
  const admitted = await admitRuntimeUse({
    command: 'appstate',
    device: session.device,
    use: appStateUse,
    inspectFacts: params.inspectFacts,
    platformServices: params.platformServices,
    bindDevice: params.bindDevice,
  });
  if (admitted.type === 'response') return undefined;
  try {
    const read = await admitted.runtime.operations.appState({ appBundleId: session.appBundleId });
    return read.applicationState;
  } catch (error) {
    if (isRequestCanceledError(error)) throw error;
    emitDiagnostic({
      level: 'warn',
      phase: 'apple_appstate_runner_read_failed',
      data: { code: asAppError(error).code, message: asAppError(error).message },
    });
    return undefined;
  }
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
 * admits a read, otherwise the session record itself. A session with no tracked foreground app
 * says so instead of inventing one.
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

  const state = await readAppleSessionAppState(params, session);
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
