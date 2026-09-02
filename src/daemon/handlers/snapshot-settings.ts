import { isMacOs } from '@agent-device/kernel/device';
import {
  getUnsupportedMacOsSettingMessage,
  isMacOsSettingSupported,
  SETTINGS_INVALID_ARGS_MESSAGE,
} from '@agent-device/contracts/settings';
import type { SettingOptions } from '@agent-device/contracts/settings';
import type { SetSettingInput } from '@agent-device/contracts/settings-runtime';
import { settingsRuntimeUse } from '@agent-device/contracts/platform-runtime-operations';
import type { BoundDeviceRuntime } from '@agent-device/contracts/platform-runtime';
import { contextFromFlags } from '../context.ts';
import { SessionStore } from '../session-store.ts';
import type { DaemonRequest, DaemonResponse, SessionState } from '../types.ts';
import { recordIfSession } from '../snapshot-session.ts';
import { errorResponse, type DaemonFailureResponse } from '../response.ts';
import { expireRefFrame } from '../ref-frame.ts';
import { emitDiagnostic } from '@agent-device/host-kit/diagnostics';
import { readLocationCoordinate } from '@agent-device/kernel/location-coordinates';
import { successText, withSuccessText } from '@agent-device/kernel/success-text';

import type { BindDeviceRuntime, InspectDeviceRuntimeFacts } from '../request-runtime-binding.ts';
import { admitRuntimeUse } from '../runtime-admission.ts';
import { runtimeExecutionFromContext } from '../snapshot-runtime-capture-input.ts';

type ParsedSettingsArgs = {
  setting: string;
  state: string;
  appBundleId?: string;
  permissionTarget?: string;
  permissionMode?: string;
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
  inspectFacts?: InspectDeviceRuntimeFacts;
  bindDevice?: BindDeviceRuntime;
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
      permissionMode: req.positionals?.[3],
      latitude: req.positionals?.[2],
      longitude: req.positionals?.[3],
    },
  };
}

/**
 * The owner-facing options for one mutation. `permission` and `location set` are the two settings
 * whose payload is not just `(setting, state)`; everything else sends none. Coordinate typing
 * happens here rather than in the owner: `readLocationCoordinate` is input validation, and it
 * throws the same `INVALID_ARGS` the retired dispatcher threw from the same point in the
 * sequence — after admission, after the frame expiry and the diagnostic, immediately before the
 * device call.
 */
function buildSettingOptions(parsed: ParsedSettingsArgs): SettingOptions | undefined {
  if (parsed.setting === 'permission') {
    return { permissionTarget: parsed.permissionTarget, permissionMode: parsed.permissionMode };
  }
  if (parsed.setting === 'location' && parsed.state === 'set') {
    return {
      latitude: readLocationCoordinate(parsed.latitude, 'latitude'),
      longitude: readLocationCoordinate(parsed.longitude, 'longitude'),
    };
  }
  return undefined;
}

/** The `settings_apply` payload the retired dispatcher emitted, kept byte-for-byte. */
function settingsDiagnosticData(
  parsed: ParsedSettingsArgs,
  appBundleId: string | undefined,
  platform: string,
): Record<string, unknown> {
  const { setting, state } = parsed;
  if (setting === 'clear-app-state') {
    return { setting: 'clear-app-state', state: 'clear', appBundleId, platform };
  }
  if (setting === 'location' && state === 'set') {
    return { setting, state, latitude: parsed.latitude, longitude: parsed.longitude, platform };
  }
  if (setting === 'permission') {
    return {
      setting,
      state,
      permissionTarget: parsed.permissionTarget,
      permissionMode: parsed.permissionMode,
      platform,
    };
  }
  return { setting, state, appBundleId, platform };
}

function readResultMessage(result: Record<string, unknown>): string | undefined {
  return typeof result.message === 'string' && result.message.length > 0
    ? result.message
    : undefined;
}

/**
 * The ONE place a bound `settings` executes (R58). The owner answers with its own payload or
 * nothing; either way the response carries the requested `setting`/`state` and a message the
 * owner may override, exactly as the retired leaf composed it.
 */
async function executeSetSetting(
  runtime: BoundDeviceRuntime<typeof settingsRuntimeUse>,
  input: SetSettingInput,
  fallbackMessage: string,
): Promise<Record<string, unknown>> {
  const { setting, state } = input;
  const result = await runtime.operations.setSetting(input);
  return result && typeof result === 'object'
    ? withSuccessText({ setting, state, ...result }, readResultMessage(result) ?? fallbackMessage)
    : { setting, state, ...successText(fallbackMessage) };
}

export async function handleSettingsCommand(
  params: HandleSettingsCommandParams,
): Promise<DaemonResponse> {
  const { req, logPath, sessionStore, session, device, parsed, inspectFacts, bindDevice } = params;
  const { setting, state } = parsed;
  const admission = await admitRuntimeUse({
    command: 'settings',
    device,
    use: settingsRuntimeUse,
    inspectFacts,
    bindDevice,
  });
  if (admission.type === 'response') return admission.response;
  if (isMacOs(device) && !isMacOsSettingSupported(setting)) {
    return errorResponse('INVALID_ARGS', getUnsupportedMacOsSettingMessage(setting));
  }

  const appBundleId = parsed.appBundleId ?? session?.appBundleId;
  if (setting === 'clear-app-state' && !appBundleId) {
    return errorResponse(
      'INVALID_ARGS',
      'settings clear-app-state requires an app id when no app is bound to the session',
    );
  }
  // ADR 0014 side-effect seam: a settings mutation changes device state; expire the frame before
  // the bound call (settings is always classified may-invalidate). It runs here, ahead of the
  // diagnostic and the coordinate typing, because that is where the retired daemon route expired
  // it — a request that later fails on a bad coordinate expired the frame then and expires it now.
  if (session) expireRefFrame(session);
  emitDiagnostic({
    level: 'debug',
    phase: 'settings_apply',
    data: settingsDiagnosticData(parsed, appBundleId, device.platform),
  });
  const options = buildSettingOptions(parsed);
  const context = contextFromFlags(logPath, req.flags, appBundleId, session?.trace?.outPath);
  const data = await executeSetSetting(
    admission.runtime,
    {
      setting,
      state,
      ...(appBundleId === undefined ? {} : { appBundleId }),
      ...(options === undefined ? {} : { options }),
      execution: runtimeExecutionFromContext(context),
    },
    setting === 'clear-app-state'
      ? `Cleared user data for ${appBundleId}`
      : `Updated setting: ${setting}`,
  );
  recordIfSession(sessionStore, session, req, data);
  return { ok: true, data };
}
