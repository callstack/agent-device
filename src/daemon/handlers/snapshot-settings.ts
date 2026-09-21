import { isMacOs } from '@agent-device/kernel/device';
import {
  getUnsupportedMacOsSettingMessage,
  isMacOsSettingSupported,
  invalidTextSizeMessage,
  readTextSizeCategory,
  resolveSettingsReadRequest,
  SETTINGS_INVALID_ARGS_MESSAGE,
  type ReadableSetting,
  type SettingOptions,
} from '@agent-device/contracts/settings';
import type { SetSettingInput } from '@agent-device/contracts/settings-runtime';
import {
  settingReadUse,
  settingsRuntimeUse,
} from '@agent-device/contracts/platform-runtime-operations';
import type { BoundDeviceRuntime } from '@agent-device/contracts/platform-runtime';
import { contextFromFlags } from '../context.ts';
import { SessionStore } from '../session-store.ts';
import type { DaemonRequest, DaemonResponse } from '../daemon-request.ts';
import type { SessionState } from '../session-state.ts';
import { recordIfSession } from '../snapshot-session.ts';
import { expireRefFrame } from '../ref-frame.ts';
import { emitDiagnostic } from '@agent-device/host-kit/diagnostics';
import { readLocationCoordinate } from '@agent-device/kernel/location-coordinates';
import { successText, withSuccessText } from '@agent-device/kernel/success-text';

import type { BindDeviceRuntime, InspectDeviceRuntimeFacts } from '../request-runtime-binding.ts';
import { admitRuntimeUse } from '../runtime-admission.ts';
import { runtimeExecutionFromContext } from '../snapshot-runtime-capture-input.ts';
import { type DaemonFailureResponse, errorResponse } from '@agent-device/kernel/contracts';

type ParsedSettingsArgs = {
  setting: string;
  state: string;
  appBundleId?: string;
  permissionTarget?: string;
  permissionMode?: string;
  latitude?: string;
  longitude?: string;
};

/**
 * Which half of the settings surface a request asks for. A bare `settings <setting>` names a
 * setting the command vocabulary declares readable and runs the owner's read leg; everything else
 * is the mutation it has always been. The legs are separate because an owner admits one without the
 * other — the macOS host sets an appearance it has no ladder to read back.
 */
export type ParsedSettingsRequest =
  | Readonly<{ leg: 'read'; setting: ReadableSetting }>
  | Readonly<{ leg: 'write'; args: ParsedSettingsArgs }>;

type HandleSettingsCommandParams = {
  req: DaemonRequest;
  logPath: string;
  sessionStore: SessionStore;
  session: SessionState | undefined;
  device: SessionState['device'];
  parsed: ParsedSettingsRequest;
  inspectFacts?: InspectDeviceRuntimeFacts;
  bindDevice?: BindDeviceRuntime;
};

export function parseSettingsArgs(
  req: DaemonRequest,
): { ok: true; parsed: ParsedSettingsRequest } | DaemonFailureResponse {
  const setting = req.positionals?.[0]?.toLowerCase();
  const state = req.positionals?.[1]?.toLowerCase();
  const permissionTarget = req.positionals?.[2]?.toLowerCase();
  if (setting === 'clear-app-state') {
    const appBundleId = state === 'clear' ? req.positionals?.[2] : req.positionals?.[1];
    return {
      ok: true,
      parsed: {
        leg: 'write',
        args: {
          setting,
          state: 'clear',
          appBundleId,
        },
      },
    };
  }
  const readSetting = resolveSettingsReadRequest(req.positionals);
  if (readSetting !== undefined) {
    return { ok: true, parsed: { leg: 'read', setting: readSetting } };
  }
  if (
    !setting ||
    !state ||
    (setting === 'permission' && !permissionTarget) ||
    (setting === 'location' &&
      state === 'set' &&
      (!req.positionals?.[2] || !req.positionals?.[3])) ||
    (setting === 'reset-keychain' && req.positionals?.[2] !== undefined)
  ) {
    return errorResponse('INVALID_ARGS', SETTINGS_INVALID_ARGS_MESSAGE);
  }
  // A text size that is not on the ladder is refused here, ahead of admission and of any device
  // call: `simctl` answers an unknown category with exit 0, so a write that reached the tool with
  // it would have reported success while changing nothing. The refusal carries the whole ladder.
  let validatedState = state;
  if (setting === 'text-size') {
    const category = readTextSizeCategory(state);
    if (category === undefined) {
      return errorResponse('INVALID_ARGS', invalidTextSizeMessage(state));
    }
    validatedState = category;
  }
  return {
    ok: true,
    parsed: {
      leg: 'write',
      args: {
        setting,
        state: validatedState,
        permissionTarget,
        permissionMode: req.positionals?.[3],
        latitude: req.positionals?.[2],
        longitude: req.positionals?.[3],
      },
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
  if (params.parsed.leg === 'read') return await executeSettingsRead(params, params.parsed.setting);
  return await executeSettingsWrite(params, params.parsed.args);
}

/**
 * The ONE place `settings <setting>` reads a device (ADR 0019 §9). It admits the owner's read fact
 * rather than its write fact, so a leaf that can change a value it cannot report — or the reverse —
 * refuses with its own cell instead of running the wrong leg. Nothing here expires the session ref
 * frame or mutates anything: the read is the reason that leg exists.
 */
async function executeSettingsRead(
  params: HandleSettingsCommandParams,
  setting: ReadableSetting,
): Promise<DaemonResponse> {
  const { req, logPath, sessionStore, session, device, inspectFacts, bindDevice } = params;
  const admission = await admitRuntimeUse({
    command: `settings ${setting}`,
    device,
    use: settingReadUse,
    inspectFacts,
    bindDevice,
    ...(session ? {} : { readiness: {} }),
  });
  if (admission.type === 'response') return admission.response;

  emitDiagnostic({
    level: 'debug',
    phase: 'settings_read',
    data: { setting, platform: device.platform },
  });
  const context = contextFromFlags(
    logPath,
    req.flags,
    session?.appBundleId,
    session?.trace?.outPath,
  );
  const payload = await admission.runtime.operations.readSetting({
    setting,
    execution: runtimeExecutionFromContext(context),
  });
  const data = {
    setting,
    ...payload,
    ...successText(`Text size is ${payload.category}`),
  };
  recordIfSession(sessionStore, session, req, data);
  return { ok: true, data };
}

async function executeSettingsWrite(
  params: HandleSettingsCommandParams,
  parsed: ParsedSettingsArgs,
): Promise<DaemonResponse> {
  const { req, logPath, sessionStore, session, device, inspectFacts, bindDevice } = params;
  const { setting, state } = parsed;
  const admission = await admitRuntimeUse({
    command: 'settings',
    device,
    use: settingsRuntimeUse,
    inspectFacts,
    bindDevice,
    ...(session ? {} : { readiness: {} }),
  });
  // Explicit positional wins; the Maestro adapter's daemon-internal
  // settingsAppBundleId overrides the session app for cross-app targeting.
  const appBundleId =
    parsed.appBundleId ?? req.internal?.settingsAppBundleId ?? session?.appBundleId;
  if (admission.type === 'response') return admission.response;
  const refusal = settingsWriteRefusal(device, parsed, appBundleId);
  if (refusal !== undefined) return refusal;
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
  const data = await executeSetSetting(
    admission.runtime,
    settingsWriteInput(
      parsed,
      appBundleId,
      contextFromFlags(logPath, req.flags, appBundleId, session?.trace?.outPath),
    ),
    writeSuccessMessage(setting, state, appBundleId),
  );
  recordIfSession(sessionStore, session, req, data);
  return { ok: true, data };
}

/**
 * The refusals a settings mutation makes after admission and before any device call. Both key on the
 * requested setting rather than on the device, which is why they are daemon-side and not owner facts:
 * macOS serves `settings` and still refuses `wifi`, and `clear-app-state` needs an app the session
 * may not carry.
 */
function settingsWriteRefusal(
  device: SessionState['device'],
  parsed: ParsedSettingsArgs,
  appBundleId: string | undefined,
): DaemonResponse | undefined {
  if (isMacOs(device) && !isMacOsSettingSupported(parsed.setting)) {
    return errorResponse('INVALID_ARGS', getUnsupportedMacOsSettingMessage(parsed.setting));
  }
  if (parsed.setting === 'clear-app-state' && !appBundleId) {
    return errorResponse(
      'INVALID_ARGS',
      'settings clear-app-state requires an app id when no app is bound to the session',
    );
  }
  return undefined;
}

/** The owner-facing input for one mutation: the named setting and state, plus only the extras it carries. */
function settingsWriteInput(
  parsed: ParsedSettingsArgs,
  appBundleId: string | undefined,
  context: Parameters<typeof runtimeExecutionFromContext>[0],
): SetSettingInput {
  const options = buildSettingOptions(parsed);
  return {
    setting: parsed.setting,
    state: parsed.state,
    ...(appBundleId === undefined ? {} : { appBundleId }),
    ...(options === undefined ? {} : { options }),
    execution: runtimeExecutionFromContext(context),
  };
}

function writeSuccessMessage(
  setting: string,
  state: string,
  appBundleId: string | undefined,
): string {
  if (setting === 'clear-app-state') return `Cleared user data for ${appBundleId}`;
  if (setting === 'text-size') return `Text size set to ${state}`;
  return `Updated setting: ${setting}`;
}
