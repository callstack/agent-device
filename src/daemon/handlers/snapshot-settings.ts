import { isMacOs } from '../../kernel/device.ts';
import {
  getUnsupportedMacOsSettingMessage,
  isMacOsSettingSupported,
  SETTINGS_INVALID_ARGS_MESSAGE,
} from '../../core/settings-contract.ts';
import { dispatchCommand } from '../../core/dispatch.ts';
import { contextFromFlags } from '../context.ts';
import { SessionStore } from '../session-store.ts';
import type { DaemonRequest, DaemonResponse, SessionState } from '../types.ts';
import { recordIfSession } from './snapshot-session.ts';
import { errorResponse, requireCommandSupported, type DaemonFailureResponse } from './response.ts';

type ParsedSettingsArgs = {
  setting: string;
  state: string;
  appBundleId?: string;
  permissionTarget?: string;
  latitude?: string;
  longitude?: string;
};

type HandleSettingsCommandParams = {
  req: DaemonRequest;
  logPath: string;
  sessionStore: SessionStore;
  session: SessionState | undefined;
  device: SessionState['device'];
  parsed: ParsedSettingsArgs;
};

export function parseSettingsArgs(
  req: DaemonRequest,
): { ok: true; parsed: ParsedSettingsArgs } | DaemonFailureResponse {
  const setting = req.positionals?.[0]?.toLowerCase();
  const state = req.positionals?.[1]?.toLowerCase();
  const permissionTarget = req.positionals?.[2]?.toLowerCase();
  if (setting === 'clear-app-state') {
    const appBundleId = state === 'clear' ? req.positionals?.[2] : req.positionals?.[1];
    return {
      ok: true,
      parsed: {
        setting,
        state: 'clear',
        appBundleId,
      },
    };
  }
  if (
    !setting ||
    !state ||
    (setting === 'permission' && !permissionTarget) ||
    (setting === 'location' && state === 'set' && (!req.positionals?.[2] || !req.positionals?.[3]))
  ) {
    return errorResponse('INVALID_ARGS', SETTINGS_INVALID_ARGS_MESSAGE);
  }
  return {
    ok: true,
    parsed: {
      setting,
      state,
      permissionTarget,
      latitude: req.positionals?.[2],
      longitude: req.positionals?.[3],
    },
  };
}

export async function handleSettingsCommand(
  params: HandleSettingsCommandParams,
): Promise<DaemonResponse> {
  const { req, logPath, sessionStore, session, device, parsed } = params;
  const {
    setting,
    state,
    appBundleId: parsedAppBundleId,
    permissionTarget,
    latitude,
    longitude,
  } = parsed;
  const unsupported = requireCommandSupported('settings', device);
  if (unsupported) return unsupported;
  if (isMacOs(device) && !isMacOsSettingSupported(setting)) {
    return errorResponse('INVALID_ARGS', getUnsupportedMacOsSettingMessage(setting));
  }

  const appBundleId = parsedAppBundleId ?? session?.appBundleId;
  if (setting === 'clear-app-state' && !appBundleId) {
    return errorResponse(
      'INVALID_ARGS',
      'settings clear-app-state requires an app id when no app is bound to the session',
    );
  }
  // Settings positional layout for dispatch: setting, state, command payload, appBundleId.
  const positionals =
    setting === 'clear-app-state'
      ? [setting, state, appBundleId ?? '']
      : setting === 'permission'
        ? [setting, state, permissionTarget ?? '', req.positionals?.[3] ?? '', appBundleId ?? '']
        : setting === 'location' && state === 'set'
          ? [setting, state, latitude ?? '', longitude ?? '', appBundleId ?? '']
          : [setting, state, appBundleId ?? ''];
  const data = await dispatchCommand(device, 'settings', positionals, req.flags?.out, {
    ...contextFromFlags(logPath, req.flags, appBundleId, session?.trace?.outPath),
  });
  recordIfSession(sessionStore, session, req, data ?? { setting, state });
  return { ok: true, data: data ?? { setting, state } };
}
