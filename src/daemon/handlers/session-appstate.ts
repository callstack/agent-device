import { isApplePlatform } from '@agent-device/kernel/device';
import { errorResponse } from '@agent-device/kernel/contracts';
import {
  hasExplicitSessionFlag,
  requireSessionOrExplicitSelector,
  resolveCommandDevice,
  selectorTargetsSessionDevice,
} from '../session-device-resolution.ts';
import type { RuntimeCommandHandlerParams } from '../session-runtime-admission.ts';
import type { DaemonResponse } from '../daemon-request.ts';
import {
  appleSessionAppStateResponse,
  appleSessionRequiredRefusal,
} from './session-appstate-apple-session.ts';
import { queryDeviceRuntimeAppState } from './session-appstate-device-runtime.ts';

function appStateSessionNotFoundResponse(
  sessionName: string,
  platform: string | undefined,
): DaemonResponse {
  if (platform === 'ios') {
    return errorResponse(
      'SESSION_NOT_FOUND',
      `No active session "${sessionName}". Run open with --session ${sessionName} first.`,
    );
  }
  return errorResponse(
    'SESSION_NOT_FOUND',
    `No active session "${sessionName}". Run open with --session ${sessionName} first, or omit --session to query by device selector.`,
  );
}

/**
 * Has this appstate request an answerable target, and which authority answers it: the Apple
 * session it points at, or the device runtime the selector resolves to. Every way the request can
 * be refused without a device answers here.
 */
function admitAppStateTarget(
  params: RuntimeCommandHandlerParams,
): { refusal: DaemonResponse } | { answeredBy: 'apple-session' | 'device-runtime' } {
  const { req, sessionName, sessionStore } = params;
  const session = sessionStore.get(sessionName);
  const flags = req.flags ?? {};
  const normalizedPlatform = flags.platform;

  if (!session && hasExplicitSessionFlag(flags)) {
    return { refusal: appStateSessionNotFoundResponse(sessionName, normalizedPlatform) };
  }

  const guard = requireSessionOrExplicitSelector('appstate', session, flags);
  if (guard) return { refusal: guard };

  const useSessionStateForApple =
    isApplePlatform(session?.device.platform) && selectorTargetsSessionDevice(flags, session);

  if (normalizedPlatform === 'ios' && !useSessionStateForApple) {
    return { refusal: appleSessionRequiredRefusal('ios') };
  }
  if (normalizedPlatform === 'macos' && !useSessionStateForApple) {
    return { refusal: appleSessionRequiredRefusal('macos') };
  }
  return { answeredBy: useSessionStateForApple && session ? 'apple-session' : 'device-runtime' };
}

/**
 * Which app is in the foreground: the Apple session's record and runner answer for their own
 * devices; every other target is resolved and answered by its device runtime.
 */
export async function handleAppStateCommand(
  params: RuntimeCommandHandlerParams,
): Promise<DaemonResponse> {
  const target = admitAppStateTarget(params);
  if ('refusal' in target) return target.refusal;

  const session = params.sessionStore.get(params.sessionName);
  if (target.answeredBy === 'apple-session' && session) {
    return await appleSessionAppStateResponse(params, session);
  }
  const device = await resolveCommandDevice({
    session,
    flags: params.req.flags ?? {},
    platformServices: params.platformServices,
  });
  return await queryDeviceRuntimeAppState(params, device);
}
