import type { DaemonResponse } from '@agent-device/kernel/contracts';
import { isApplePlatform, type PlatformSelector } from '@agent-device/kernel/device';
import { errorResponse, namesSessionExplicitly } from '@agent-device/kernel/contracts';
import { namedSessionNotFoundDetails } from '@agent-device/kernel/errors';
import { hasExplicitDeviceSelector } from '../../core/device/device-selector-intent.ts';
import {
  requireSessionOrExplicitSelector,
  resolveCommandDevice,
  selectorTargetsSessionDevice,
} from '../../resources/session-device-resolution.ts';
import type { RuntimeCommandHandlerParams } from '../../core/session-runtime-admission.ts';
import {
  appleSessionAppStateResponse,
  appleSessionRequiredRefusal,
  type AppStateSessionRecord,
} from './session-appstate-apple-session.ts';
import { queryDeviceRuntimeAppState } from './session-appstate-device-runtime.ts';

function appStateSessionNotFoundResponse(
  sessionName: string,
  platform: PlatformSelector | undefined,
): DaemonResponse {
  // Every Apple selector — `apple`, `ios`, or `macos` — answers appstate only from an open
  // session and its runner, so the "omit --session" route they would otherwise be pointed at
  // just reaches the session-required refusal. Send them straight to opening the session.
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

type AppStateSessionStoreEntry = ReturnType<RuntimeCommandHandlerParams['sessionStore']['get']>;

/** The answer of target admission: a refusal, or the authority that answers with its session. */
type AppStateTargetDecision =
  | { refusal: DaemonResponse }
  | { answeredBy: 'apple-session'; session: AppStateSessionRecord }
  | { answeredBy: 'device-runtime'; session: AppStateSessionStoreEntry };

/**
 * Has this appstate request an answerable target, and which authority answers it: the Apple
 * session it points at, or the device runtime the selector resolves to. The apple-session branch
 * carries the session itself, so answering it can never re-read the store for a session that has
 * gone missing between admission and response. Every way the request can be refused without a
 * device answers here.
 */
function admitAppStateTarget(params: RuntimeCommandHandlerParams): AppStateTargetDecision {
  const { req, sessionName, sessionStore } = params;
  const session = sessionStore.get(sessionName);
  const flags = req.flags ?? {};
  const normalizedPlatform = flags.platform;

  // Same priority as the resolution guard: a non-Apple identity selector states a target this
  // command answers sessionlessly, so the refusal stays out of the way there. Apple-family
  // appstate requires an open session whatever the selector states, so the typed refusal remains
  // the only actionable answer for it.
  if (
    !session &&
    namesSessionExplicitly(req) &&
    (!hasExplicitDeviceSelector(flags) || isApplePlatform(normalizedPlatform))
  ) {
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
  if (useSessionStateForApple && session) {
    return { answeredBy: 'apple-session' as const, session };
  }
  return { answeredBy: 'device-runtime' as const, session };
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

  if (target.answeredBy === 'apple-session') {
    return await appleSessionAppStateResponse(params, target.session);
  }
  const device = await resolveCommandDevice({
    session: target.session,
    flags: params.req.flags ?? {},
    platformServices: params.platformServices,
  });
  return await queryDeviceRuntimeAppState(params, device);
}
