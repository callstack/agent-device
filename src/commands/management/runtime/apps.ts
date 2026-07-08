import type {
  BackendAppInfo,
  BackendAppListFilter,
  BackendAppState,
  BackendCommandContext,
  BackendOpenTarget,
  BackendPushInput,
} from '../../../backend.ts';
import type { JsonObject } from '../../../contracts/json.ts';
import type { FileInputRef } from '../../../io.ts';
import type { AgentDeviceRuntime, CommandContext } from '../../../runtime-contract.ts';
import { assertResolvedAppsFilter } from '../app-inventory-contract.ts';
import { AppError } from '../../../kernel/errors.ts';
import { successText } from '../../../utils/success-text.ts';
import { resolveCommandInput } from '../../io-policy.ts';
import {
  toBackendResult,
  type BackendResultEnvelope,
  type RuntimeCommand,
} from '../../runtime-types.ts';
import { normalizeOptionalText, requireText } from '../../text.ts';

const APP_EVENT_NAME_PATTERN = /^[A-Za-z0-9_.:-]{1,64}$/;
const MAX_APP_EVENT_PAYLOAD_BYTES = 8 * 1024;
const MAX_APP_PUSH_PAYLOAD_BYTES = 8 * 1024;

export type OpenAppCommandOptions = CommandContext &
  BackendOpenTarget & {
    launchArgs?: string[];
    relaunch?: boolean;
  };

export type OpenAppCommandResult = {
  kind: 'appOpened';
  target: BackendOpenTarget;
  relaunch: boolean;
} & BackendResultEnvelope;

export type CloseAppCommandOptions = CommandContext & {
  app?: string;
};

export type CloseAppCommandResult = {
  kind: 'appClosed';
  app?: string;
} & BackendResultEnvelope;

export type ListAppsCommandOptions = CommandContext & {
  filter?: BackendAppListFilter;
};

export type ListAppsCommandResult = {
  kind: 'appsList';
  apps: readonly BackendAppInfo[];
};

export type GetAppStateCommandOptions = CommandContext & {
  app: string;
};

export type GetAppStateCommandResult = {
  kind: 'appState';
  app: string;
  state: BackendAppState;
};

export type AppPushInput =
  | {
      kind: 'json';
      payload: JsonObject;
    }
  | FileInputRef;

export type PushAppCommandOptions = CommandContext & {
  app: string;
  input: AppPushInput;
};

export type PushAppCommandResult = {
  kind: 'appPushed';
  app: string;
  inputKind: 'json' | 'file';
} & BackendResultEnvelope;

export type TriggerAppEventCommandOptions = CommandContext & {
  name: string;
  payload?: JsonObject;
};

export type TriggerAppEventCommandResult = {
  kind: 'appEventTriggered';
  name: string;
  payload?: JsonObject;
} & BackendResultEnvelope;

export const openAppCommand: RuntimeCommand<OpenAppCommandOptions, OpenAppCommandResult> = async (
  runtime,
  options,
): Promise<OpenAppCommandResult> => {
  if (!runtime.backend.openApp) {
    throw new AppError('UNSUPPORTED_OPERATION', 'apps.open is not supported by this backend');
  }

  const target = normalizeOpenTarget(options);
  const backendResult = await runtime.backend.openApp(
    toAppBackendContext(runtime, options),
    target,
    {
      launchArgs: options.launchArgs,
      relaunch: options.relaunch,
    },
  );

  const formattedBackendResult = toBackendResult(backendResult);
  return {
    kind: 'appOpened',
    target,
    relaunch: options.relaunch === true,
    ...(formattedBackendResult ? { backendResult: formattedBackendResult } : {}),
    ...successText(`Opened: ${formatOpenTarget(target)}`),
  };
};

export const closeAppCommand: RuntimeCommand<
  CloseAppCommandOptions | undefined,
  CloseAppCommandResult
> = async (runtime, options = {}): Promise<CloseAppCommandResult> => {
  if (!runtime.backend.closeApp) {
    throw new AppError('UNSUPPORTED_OPERATION', 'apps.close is not supported by this backend');
  }

  const app = normalizeOptionalText(options.app, 'app');
  const backendResult = await runtime.backend.closeApp(toAppBackendContext(runtime, options), app);

  const formattedBackendResult = toBackendResult(backendResult);
  return {
    kind: 'appClosed',
    ...(app ? { app } : {}),
    ...(formattedBackendResult ? { backendResult: formattedBackendResult } : {}),
    ...successText(app ? `Closed: ${app}` : 'Closed app'),
  };
};

export const listAppsCommand: RuntimeCommand<
  ListAppsCommandOptions | undefined,
  ListAppsCommandResult
> = async (runtime, options = {}): Promise<ListAppsCommandResult> => {
  if (!runtime.backend.listApps) {
    throw new AppError('UNSUPPORTED_OPERATION', 'apps.list is not supported by this backend');
  }

  const apps = await runtime.backend.listApps(
    toAppBackendContext(runtime, options),
    assertResolvedAppsFilter(options.filter),
  );
  return {
    kind: 'appsList',
    apps,
  };
};

export const getAppStateCommand: RuntimeCommand<
  GetAppStateCommandOptions,
  GetAppStateCommandResult
> = async (runtime, options): Promise<GetAppStateCommandResult> => {
  if (!runtime.backend.getAppState) {
    throw new AppError('UNSUPPORTED_OPERATION', 'apps.state is not supported by this backend');
  }

  const app = requireText(options.app, 'app');
  const state = await runtime.backend.getAppState(toAppBackendContext(runtime, options), app);
  return {
    kind: 'appState',
    app,
    state,
  };
};

export const pushAppCommand: RuntimeCommand<PushAppCommandOptions, PushAppCommandResult> = async (
  runtime,
  options,
): Promise<PushAppCommandResult> => {
  if (!runtime.backend.pushFile) {
    throw new AppError('UNSUPPORTED_OPERATION', 'apps.push is not supported by this backend');
  }

  const app = requireText(options.app, 'app');
  const input = await resolvePushInput(runtime, options.input);
  try {
    const backendResult = await runtime.backend.pushFile(
      toAppBackendContext(runtime, options),
      input.backendInput,
      app,
    );
    const formattedBackendResult = toBackendResult(backendResult);
    return {
      kind: 'appPushed',
      app,
      inputKind: input.inputKind,
      ...(formattedBackendResult ? { backendResult: formattedBackendResult } : {}),
      ...successText(`Pushed to ${app}`),
    };
  } finally {
    await input.cleanup?.();
  }
};

export const triggerAppEventCommand: RuntimeCommand<
  TriggerAppEventCommandOptions,
  TriggerAppEventCommandResult
> = async (runtime, options): Promise<TriggerAppEventCommandResult> => {
  if (!runtime.backend.triggerAppEvent) {
    throw new AppError(
      'UNSUPPORTED_OPERATION',
      'apps.triggerEvent is not supported by this backend',
    );
  }

  const name = requireAppEventName(options.name);
  assertPayload(options.payload, `apps.triggerEvent payload for "${name}"`);
  const backendResult = await runtime.backend.triggerAppEvent(
    toAppBackendContext(runtime, options),
    {
      name,
      ...(options.payload ? { payload: options.payload } : {}),
    },
  );

  const formattedBackendResult = toBackendResult(backendResult);
  return {
    kind: 'appEventTriggered',
    name,
    ...(options.payload ? { payload: options.payload } : {}),
    ...(formattedBackendResult ? { backendResult: formattedBackendResult } : {}),
    ...successText(`Triggered app event: ${name}`),
  };
};

function normalizeOpenTarget(options: OpenAppCommandOptions): BackendOpenTarget {
  const app = normalizeOptionalText(options.app, 'app');
  const appId = normalizeOptionalText(options.appId, 'appId');
  const bundleId = normalizeOptionalText(options.bundleId, 'bundleId');
  const packageName = normalizeOptionalText(options.packageName, 'packageName');
  const url = normalizeOptionalText(options.url, 'url');
  const activity = normalizeOptionalText(options.activity, 'activity');
  const target: BackendOpenTarget = {
    ...(app ? { app } : {}),
    ...(appId ? { appId } : {}),
    ...(bundleId ? { bundleId } : {}),
    ...(packageName ? { packageName } : {}),
    ...(url ? { url } : {}),
    ...(activity ? { activity } : {}),
  };
  if (!hasOpenTarget(target)) {
    throw new AppError(
      'INVALID_ARGS',
      'apps.open requires app, appId, bundleId, packageName, url, or activity',
    );
  }
  return target;
}

function hasOpenTarget(target: BackendOpenTarget): boolean {
  return Boolean(
    target.app ??
    target.appId ??
    target.bundleId ??
    target.packageName ??
    target.url ??
    target.activity,
  );
}

function formatOpenTarget(target: BackendOpenTarget): string {
  return (
    target.app ??
    target.appId ??
    target.bundleId ??
    target.packageName ??
    target.url ??
    target.activity ??
    'app'
  );
}

async function resolvePushInput(
  runtime: AgentDeviceRuntime,
  input: AppPushInput | undefined,
): Promise<{
  backendInput: BackendPushInput;
  inputKind: 'json' | 'file';
  cleanup?: () => Promise<void>;
}> {
  if (!input || typeof input !== 'object') {
    throw new AppError('INVALID_ARGS', 'apps.push requires an input');
  }
  if (input.kind === 'json') {
    validateJsonObjectPayload(input.payload, 'apps.push JSON payload', MAX_APP_PUSH_PAYLOAD_BYTES);
    return {
      backendInput: { kind: 'json', payload: input.payload },
      inputKind: 'json',
    };
  }

  const resolved = await resolveCommandInput(runtime, input, {
    usage: 'apps.push',
    field: 'input',
  });
  return {
    backendInput: { kind: 'file', path: resolved.path },
    inputKind: 'file',
    ...(resolved.cleanup ? { cleanup: resolved.cleanup } : {}),
  };
}

function requireAppEventName(name: string): string {
  const normalized = requireText(name, 'name');
  if (!APP_EVENT_NAME_PATTERN.test(normalized)) {
    throw new AppError('INVALID_ARGS', `Invalid apps.triggerEvent name: ${normalized}`, {
      hint: 'Use 1-64 chars: letters, numbers, underscore, dot, colon, or dash.',
    });
  }
  return normalized;
}

function assertPayload(payload: JsonObject | undefined, field: string): void {
  if (payload === undefined) return;
  validateJsonObjectPayload(payload, field, MAX_APP_EVENT_PAYLOAD_BYTES);
}

function validateJsonObjectPayload(payload: JsonObject, field: string, maxBytes: number): void {
  assertJsonObject(payload, field);
  const payloadBytes = Buffer.byteLength(stringifyJsonObject(payload, field), 'utf8');
  if (payloadBytes > maxBytes) {
    throw new AppError('INVALID_ARGS', `${field} exceeds ${maxBytes} bytes`);
  }
}

function assertJsonObject(payload: JsonObject, field: string): void {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new AppError('INVALID_ARGS', `${field} must be a JSON object`);
  }
}

function stringifyJsonObject(payload: JsonObject, field: string): string {
  try {
    const serialized = JSON.stringify(payload);
    if (typeof serialized !== 'string') {
      throw new AppError('INVALID_ARGS', `${field} must be JSON-serializable`);
    }
    return serialized;
  } catch {
    throw new AppError('INVALID_ARGS', `${field} must be JSON-serializable`);
  }
}

function toAppBackendContext(
  runtime: Pick<AgentDeviceRuntime, 'signal'>,
  options: CommandContext,
): BackendCommandContext {
  return {
    session: options.session,
    requestId: options.requestId,
    signal: options.signal ?? runtime.signal,
    metadata: options.metadata,
  };
}
