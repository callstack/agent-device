import type { DaemonPlatformServices } from '../platform-services.ts';
import { isApplePlatform } from '@agent-device/kernel/device';
import type { DaemonRequest, DaemonResponse } from '../daemon-request.ts';
import { SessionStore } from '../session-store.ts';
import {
  hasExplicitSessionFlag,
  requireSessionOrExplicitSelector,
  resolveCommandDevice,
  selectorTargetsSessionDevice,
} from '../session-device-resolution.ts';
import type { BindDeviceRuntime, InspectDeviceRuntimeFacts } from '../request-runtime-binding.ts';
import type { RuntimeCommandHandlerParams } from '../session-runtime-admission.ts';
import { errorResponse } from '@agent-device/kernel/contracts';
import { handleBootCommand } from './session-boot.ts';
import { handleShutdownCommand } from './session-shutdown.ts';
import { appleSessionAppStateResponse } from './session-appstate-apple-session.ts';
import { queryDeviceRuntimeAppState } from './session-appstate-device-runtime.ts';

const IOS_APPSTATE_SESSION_REQUIRED_MESSAGE =
  'iOS appstate requires an active session on the target device. Run open first (for example: open --session sim --platform ios --device "<name>" <app>).';
const MACOS_APPSTATE_SESSION_REQUIRED_MESSAGE =
  'macOS appstate requires an active session on the target device. Run open first (for example: open --session macos --platform macos "System Settings").';

async function handleAppStateCommand(params: RuntimeCommandHandlerParams): Promise<DaemonResponse> {
  const { req, sessionName, sessionStore } = params;
  const session = sessionStore.get(sessionName);
  const flags = req.flags ?? {};
  const normalizedPlatform = flags.platform;

  if (!session && hasExplicitSessionFlag(flags)) {
    const message =
      normalizedPlatform === 'ios'
        ? `No active session "${sessionName}". Run open with --session ${sessionName} first.`
        : `No active session "${sessionName}". Run open with --session ${sessionName} first, or omit --session to query by device selector.`;
    return errorResponse('SESSION_NOT_FOUND', message);
  }

  const guard = requireSessionOrExplicitSelector('appstate', session, flags);
  if (guard) return guard;

  const shouldUseSessionStateForApple =
    isApplePlatform(session?.device.platform) && selectorTargetsSessionDevice(flags, session);
  const targetsIos = normalizedPlatform === 'ios';
  const targetsMacOs = normalizedPlatform === 'macos';

  if (targetsIos && !shouldUseSessionStateForApple) {
    return errorResponse('SESSION_NOT_FOUND', IOS_APPSTATE_SESSION_REQUIRED_MESSAGE);
  }
  if (targetsMacOs && !shouldUseSessionStateForApple) {
    return errorResponse('SESSION_NOT_FOUND', MACOS_APPSTATE_SESSION_REQUIRED_MESSAGE);
  }

  if (shouldUseSessionStateForApple && session) {
    return await appleSessionAppStateResponse(params, session);
  }

  const device = await resolveCommandDevice({
    session,
    flags,
    platformServices: params.platformServices,
  });
  return await queryDeviceRuntimeAppState(params, device);
}

export async function handleSessionStateCommands(params: {
  req: DaemonRequest;
  sessionName: string;
  sessionStore: SessionStore;
  inspectFacts?: InspectDeviceRuntimeFacts;
  platformServices: DaemonPlatformServices;
  bindDevice?: BindDeviceRuntime;
}): Promise<DaemonResponse | null> {
  const { req, sessionName, sessionStore } = params;

  if (req.command === 'boot') {
    return await handleBootCommand({
      req,
      sessionName,
      sessionStore,
      inspectFacts: params.inspectFacts,
      platformServices: params.platformServices,
      bindDevice: params.bindDevice,
    });
  }

  if (req.command === 'shutdown') {
    return await handleShutdownCommand({
      req,
      sessionName,
      sessionStore,
      inspectFacts: params.inspectFacts,
      platformServices: params.platformServices,
      bindDevice: params.bindDevice,
    });
  }

  if (req.command === 'appstate') {
    return await handleAppStateCommand({
      req,
      sessionName,
      sessionStore,
      inspectFacts: params.inspectFacts,
      platformServices: params.platformServices,
      bindDevice: params.bindDevice,
    });
  }

  return null;
}
