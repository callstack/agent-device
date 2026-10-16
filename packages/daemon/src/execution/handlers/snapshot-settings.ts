import type { DaemonPlatformServices } from '../../core/platform-services.ts';
import { isApplePlatform, isMacOs } from '@agent-device/kernel/device';
import {
  describeSettingRead,
  describeSettingWrite,
  parseSettingsMutation,
  settingsAppNotConsumedRefusal,
  settingsAppScope,
  type SettingsMutation,
  type SettingOptions,
} from '@agent-device/contracts/settings';
import {
  settingDefinition,
  type ReadableSetting,
  type SettingsTargetFamily,
} from '@agent-device/contracts/settings-catalog';
import type { SetSettingInput } from '@agent-device/contracts/settings-runtime';
import {
  resolveSettingsRuntimePlan,
  settingReadUse,
  settingsRuntimeUse,
} from '@agent-device/contracts/platform-runtime-operations';
import type { BoundDeviceRuntime } from '@agent-device/contracts/platform-runtime';
import { contextFromFlags } from '../../core/context.ts';
import { SessionStore } from '../../core/session-store.ts';
import type { DaemonRequest } from '../../core/daemon-request.ts';
import type { SessionRef, SessionState } from '../../core/session-state.ts';
import { recordSessionAction } from '../../core/session-action-recorder.ts';
import { expireRefFrame } from '../../core/ref-frame.ts';
import { emitDiagnostic } from '@agent-device/host-kit/diagnostics';
import { readLocationCoordinate } from '@agent-device/kernel/location-coordinates';
import { AppError, sessionAppRequiredDetails } from '@agent-device/kernel/errors';
import { successText, withSuccessText } from '@agent-device/kernel/success-text';

import type {
  BindDeviceRuntime,
  InspectDeviceRuntimeFacts,
} from '../../core/request-runtime-binding.ts';
import { admitRuntimeUse } from '../../core/runtime-admission.ts';
import { runtimeExecutionFromContext } from '../../core/snapshot-runtime-capture-input.ts';
import {
  type DaemonFailureResponse,
  errorResponse,
  type DaemonResponse,
} from '@agent-device/kernel/contracts';

/** A bare readable setting is the read leg; an owner may admit one leg and not the other. */
export type ParsedSettingsRequest =
  | Readonly<{ leg: 'read'; setting: ReadableSetting }>
  | Readonly<{ leg: 'write'; args: SettingsMutation }>;

type HandleSettingsCommandParams = {
  req: DaemonRequest;
  logPath: string;
  sessionStore: SessionStore;
  ref: SessionRef | undefined;
  device: SessionState['device'];
  parsed: ParsedSettingsRequest;
  inspectFacts?: InspectDeviceRuntimeFacts;
  platformServices: DaemonPlatformServices;
  bindDevice?: BindDeviceRuntime;
};

export function parseSettingsArgs(
  req: DaemonRequest,
): { ok: true; parsed: ParsedSettingsRequest } | DaemonFailureResponse {
  const positionals = req.positionals ?? [];
  const plan = resolveSettingsRuntimePlan(positionals);
  if (plan.kind === 'read') {
    return { ok: true, parsed: { leg: 'read', setting: plan.setting } };
  }
  try {
    return { ok: true, parsed: { leg: 'write', args: parseSettingsMutation(positionals) } };
  } catch (error) {
    if (!(error instanceof AppError)) throw error;
    return errorResponse(error.code, error.message);
  }
}

/** Coordinates are typed here, after admission and frame expiry, right before the device call. */
function buildSettingOptions(parsed: SettingsMutation): SettingOptions | undefined {
  if (parsed.permission !== undefined) {
    return { permissionTarget: parsed.permission, permissionMode: parsed.mode };
  }
  if (parsed.latitude !== undefined) {
    return {
      latitude: readLocationCoordinate(parsed.latitude, 'latitude'),
      longitude: readLocationCoordinate(parsed.longitude, 'longitude'),
    };
  }
  return undefined;
}

function settingsDiagnosticData(
  parsed: SettingsMutation,
  appBundleId: string | undefined,
  platform: string,
): Record<string, unknown> {
  return {
    setting: parsed.setting,
    state: parsed.state,
    ...(parsed.permission === undefined
      ? {}
      : { permissionTarget: parsed.permission, permissionMode: parsed.mode }),
    ...(parsed.latitude === undefined
      ? { appBundleId }
      : { latitude: parsed.latitude, longitude: parsed.longitude }),
    platform,
  };
}

/** The owner answers with its own payload or nothing; it may override the message. */
async function executeSetSetting(
  runtime: BoundDeviceRuntime<typeof settingsRuntimeUse>,
  input: SetSettingInput,
  fallbackMessage: string,
): Promise<Record<string, unknown>> {
  const { setting, state } = input;
  const result = await runtime.operations.setSetting(input);
  return result && typeof result === 'object'
    ? withSuccessText(
        { setting, state, ...result },
        typeof result.message === 'string' && result.message.length > 0
          ? result.message
          : fallbackMessage,
      )
    : { setting, state, ...successText(fallbackMessage) };
}

export async function handleSettingsCommand(
  params: HandleSettingsCommandParams,
): Promise<DaemonResponse> {
  if (params.parsed.leg === 'read') return await executeSettingsRead(params, params.parsed.setting);
  return await executeSettingsWrite(params, params.parsed.args);
}

async function executeSettingsRead(
  params: HandleSettingsCommandParams,
  setting: ReadableSetting,
): Promise<DaemonResponse> {
  const { req, logPath, sessionStore, ref, device, inspectFacts, bindDevice, platformServices } =
    params;
  let session = ref ? sessionStore.requireCurrent(ref) : undefined;
  const admission = await admitRuntimeUse({
    command: `settings ${setting}`,
    subject: setting,
    device,
    use: settingReadUse,
    inspectFacts,
    bindDevice,
    platformServices,
    readiness: !session,
  });
  if (admission.type === 'response') return admission.response;

  session = ref ? sessionStore.requireCurrent(ref) : undefined;

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
    ...payload,
    ...successText(describeSettingRead(payload)),
  };
  recordSessionAction(sessionStore, ref, req, req.command, data);
  return { ok: true, data };
}

async function executeSettingsWrite(
  params: HandleSettingsCommandParams,
  parsed: SettingsMutation,
): Promise<DaemonResponse> {
  const { req, logPath, sessionStore, ref, device, inspectFacts, bindDevice, platformServices } =
    params;
  let session = ref ? sessionStore.requireCurrent(ref) : undefined;
  const { setting, state } = parsed;
  const appRefusal = settingsAppRefusal(device, req, setting, state);
  if (appRefusal !== undefined) return appRefusal;
  const admission = await admitRuntimeUse({
    command: `settings ${setting}`,
    subject: setting,
    device,
    use: settingsRuntimeUse,
    inspectFacts,
    bindDevice,
    platformServices,
    readiness: !session,
  });
  if (admission.type === 'response') return admission.response;
  session = ref ? sessionStore.requireCurrent(ref) : undefined;
  const appBundleId = settingsWriteAppId(req, parsed, session, device);
  const writeRefusal = settingsWriteRefusal(parsed, appBundleId);
  if (writeRefusal !== undefined) return writeRefusal;
  // ADR 0014: an admitted mutation expires the frame before the bound call; a refused one never does.
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
    describeSettingWrite(setting, state, appBundleId),
  );
  recordSessionAction(sessionStore, ref, req, req.command, data);
  return { ok: true, data };
}

/** The request input's `app` (CLI `--app`, client and MCP `app`); an empty one names nothing. */
function settingsRequestApp(req: DaemonRequest): string | undefined {
  const app = req.input?.app;
  if (typeof app !== 'string') return undefined;
  const trimmed = app.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function settingsTargetFamily(device: SessionState['device']): SettingsTargetFamily {
  if (isMacOs(device)) return 'macos-host';
  return isApplePlatform(device.platform) ? 'apple' : 'mobile';
}

/** Refuses an app named on a device-level mutation, before anything is bound. */
function settingsAppRefusal(
  device: SessionState['device'],
  req: DaemonRequest,
  setting: string,
  state: string,
): DaemonResponse | undefined {
  const app = settingsRequestApp(req);
  if (app === undefined) return undefined;
  if (settingsAppScope(settingsTargetFamily(device), setting, state) !== 'device-level') {
    return undefined;
  }
  const refusal = settingsAppNotConsumedRefusal(setting, state, app);
  return errorResponse(refusal.code, refusal.message, refusal.details, { hint: refusal.hint });
}

/**
 * The positional app, then the request's `app` where the mutation is app-scoped, then Maestro's
 * internal `settingsAppBundleId`, then the session app.
 */
function settingsWriteAppId(
  req: DaemonRequest,
  parsed: SettingsMutation,
  session: SessionState | undefined,
  device: SessionState['device'],
): string | undefined {
  const explicitApp =
    settingsAppScope(settingsTargetFamily(device), parsed.setting, parsed.state) === 'app-scoped'
      ? settingsRequestApp(req)
      : undefined;
  return parsed.app ?? explicitApp ?? req.internal?.settingsAppBundleId ?? session?.appBundleId;
}

function settingsWriteRefusal(
  parsed: SettingsMutation,
  appBundleId: string | undefined,
): DaemonResponse | undefined {
  if (settingDefinition(parsed.setting)?.appRequired && !appBundleId) {
    return errorResponse(
      'INVALID_ARGS',
      `settings ${parsed.setting} requires an app id when no app is bound to the session`,
      sessionAppRequiredDetails(),
    );
  }
  return undefined;
}

function settingsWriteInput(
  parsed: SettingsMutation,
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
