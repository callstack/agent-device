import type {
  BackendCommandContext,
  BackendDeviceFilter,
  BackendDeviceInfo,
  BackendDeviceTarget,
  BackendInstallResult,
  BackendInstallSource,
} from '../../../backend.ts';
import type { AgentDeviceRuntime, CommandContext } from '../../../runtime-contract.ts';
import { AppError } from '../../../kernel/errors.ts';
import { successText } from '../../../utils/success-text.ts';
import {
  toBackendResult,
  type BackendResultEnvelope,
  type BackendResultVariant,
  type RuntimeCommand,
} from '../../runtime-types.ts';
import { resolveCommandInput } from '../../io-policy.ts';
import { toBackendContext } from '../../runtime-common.ts';
import { normalizeOptionalText, requireText } from '../../text.ts';

export type AdminDevicesCommandOptions = CommandContext & {
  filter?: BackendDeviceFilter;
};

export type AdminDevicesCommandResult = {
  kind: 'adminDevices';
  devices: readonly BackendDeviceInfo[];
};

export type AdminBootCommandOptions = CommandContext & {
  target?: BackendDeviceTarget;
};

export type AdminBootCommandResult = {
  kind: 'deviceBooted';
  target?: BackendDeviceTarget;
} & BackendResultEnvelope;

export type AdminShutdownCommandOptions = CommandContext & {
  target?: BackendDeviceTarget;
};

export type AdminShutdownCommandResult = BackendResultVariant<{
  kind: 'deviceShutdown';
  target?: BackendDeviceTarget;
}>;

export type AdminInstallCommandOptions = CommandContext & {
  app: string;
  source: BackendInstallSource;
};

export type AdminReinstallCommandOptions = AdminInstallCommandOptions;

export type AdminInstallFromSourceCommandOptions = CommandContext & {
  app?: string;
  source: BackendInstallSource;
};

export type AdminInstallCommandResult = {
  kind: 'appInstalled' | 'appReinstalled' | 'appInstalledFromSource';
  app?: string;
  source: BackendInstallSource;
  appId?: string;
  appName?: string;
  bundleId?: string;
  packageName?: string;
  launchTarget?: string;
  installablePath?: string;
  archivePath?: string;
} & BackendResultEnvelope;

export const devicesCommand: RuntimeCommand<
  AdminDevicesCommandOptions | undefined,
  AdminDevicesCommandResult
> = async (runtime, options = {}): Promise<AdminDevicesCommandResult> => {
  if (!runtime.backend.listDevices) {
    throw new AppError('UNSUPPORTED_OPERATION', 'admin.devices is not supported by this backend');
  }
  return {
    kind: 'adminDevices',
    devices: await runtime.backend.listDevices(toBackendContext(runtime, options), options.filter),
  };
};

export const bootCommand: RuntimeCommand<
  AdminBootCommandOptions | undefined,
  AdminBootCommandResult
> = async (runtime, options = {}): Promise<AdminBootCommandResult> => {
  if (!runtime.backend.bootDevice) {
    throw new AppError('UNSUPPORTED_OPERATION', 'admin.boot is not supported by this backend');
  }
  const target = normalizeDeviceTarget(options.target);
  const backendResult = await runtime.backend.bootDevice(
    toBackendContext(runtime, options),
    target,
  );
  const formattedBackendResult = toBackendResult(backendResult);
  return {
    kind: 'deviceBooted',
    ...(target ? { target } : {}),
    ...(formattedBackendResult ? { backendResult: formattedBackendResult } : {}),
    ...successText('Booted device'),
  };
};

export const shutdownCommand: RuntimeCommand<
  AdminShutdownCommandOptions | undefined,
  AdminShutdownCommandResult
> = async (runtime, options = {}): Promise<AdminShutdownCommandResult> => {
  if (!runtime.backend.shutdownDevice) {
    throw new AppError('UNSUPPORTED_OPERATION', 'admin.shutdown is not supported by this backend');
  }
  const target = normalizeDeviceTarget(options.target);
  const backendResult = await runtime.backend.shutdownDevice(
    toBackendContext(runtime, options),
    target,
  );
  const formattedBackendResult = toBackendResult(backendResult);
  return {
    kind: 'deviceShutdown',
    ...(target ? { target } : {}),
    ...(formattedBackendResult ? { backendResult: formattedBackendResult } : {}),
    ...successText('Shutdown device'),
  };
};

export const installCommand: RuntimeCommand<
  AdminInstallCommandOptions,
  AdminInstallCommandResult
> = async (runtime, options): Promise<AdminInstallCommandResult> =>
  await runInstallCommand(runtime, options, 'install');

export const reinstallCommand: RuntimeCommand<
  AdminReinstallCommandOptions,
  AdminInstallCommandResult
> = async (runtime, options): Promise<AdminInstallCommandResult> =>
  await runInstallCommand(runtime, options, 'reinstall');

export const installFromSourceCommand: RuntimeCommand<
  AdminInstallFromSourceCommandOptions,
  AdminInstallCommandResult
> = async (runtime, options): Promise<AdminInstallCommandResult> =>
  await runInstallCommand(runtime, options, 'installFromSource');

async function runInstallCommand(
  runtime: AgentDeviceRuntime,
  options:
    | AdminInstallCommandOptions
    | AdminReinstallCommandOptions
    | AdminInstallFromSourceCommandOptions,
  mode: 'install' | 'reinstall' | 'installFromSource',
): Promise<AdminInstallCommandResult> {
  const methodName = mode === 'reinstall' ? 'reinstallApp' : 'installApp';
  const method = runtime.backend[methodName];
  if (!method) {
    throw new AppError('UNSUPPORTED_OPERATION', `admin.${mode} is not supported by this backend`);
  }

  const app =
    'app' in options && options.app !== undefined ? requireText(options.app, 'app') : undefined;
  if (mode !== 'installFromSource' && !app) {
    throw new AppError('INVALID_ARGS', `admin.${mode} requires app`);
  }

  const context = toBackendContext(runtime, options);
  const resolved = await resolveInstallSource(runtime, context, options.source);
  try {
    const result = await method.call(runtime.backend, context, {
      ...(app ? { app } : {}),
      source: resolved.source,
    });
    return formatInstallResult(mode, app, resolved.source, result);
  } finally {
    await resolved.cleanup?.();
  }
}

async function resolveInstallSource(
  runtime: AgentDeviceRuntime,
  context: BackendCommandContext,
  source: BackendInstallSource | undefined,
): Promise<{ source: BackendInstallSource; cleanup?: () => Promise<void> }> {
  const normalized = normalizeInstallSource(source);
  const localResolved = await resolveLocalInstallSource(runtime, normalized);
  try {
    const backendResolved = runtime.backend.resolveInstallSource
      ? await runtime.backend.resolveInstallSource(context, localResolved.source)
      : localResolved.source;
    return {
      source: normalizeInstallSource(backendResolved),
      ...(localResolved.cleanup ? { cleanup: localResolved.cleanup } : {}),
    };
  } catch (error) {
    if (localResolved.cleanup) {
      try {
        await localResolved.cleanup();
      } catch {
        // Best-effort cleanup; preserve the original install source resolution failure.
      }
    }
    throw error;
  }
}

async function resolveLocalInstallSource(
  runtime: AgentDeviceRuntime,
  source: BackendInstallSource,
): Promise<{ source: BackendInstallSource; cleanup?: () => Promise<void> }> {
  if (source.kind === 'url') return { source };
  const resolved = await resolveCommandInput(runtime, source, {
    usage: 'admin.install',
    field: 'source',
  });
  return {
    source: { kind: 'path', path: resolved.path },
    ...(resolved.cleanup ? { cleanup: resolved.cleanup } : {}),
  };
}

function normalizeInstallSource(source: BackendInstallSource | undefined): BackendInstallSource {
  if (!source || typeof source !== 'object') {
    throw new AppError('INVALID_ARGS', 'install source is required');
  }
  if (source.kind === 'path') {
    return { kind: 'path', path: requireText(source.path, 'source.path') };
  }
  if (source.kind === 'uploadedArtifact') {
    return { kind: 'uploadedArtifact', id: requireText(source.id, 'source.id') };
  }
  if (source.kind === 'url') {
    const url = requireText(source.url, 'source.url');
    assertHttpUrl(url);
    return { kind: 'url', url };
  }
  throw new AppError('INVALID_ARGS', 'install source kind must be path, uploadedArtifact, or url');
}

function assertHttpUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new AppError('INVALID_ARGS', `Invalid install source URL: ${url}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new AppError('INVALID_ARGS', 'Install source URL must use http or https');
  }
}

function normalizeDeviceTarget(
  target: BackendDeviceTarget | undefined,
): BackendDeviceTarget | undefined {
  if (!target) return undefined;
  const id = normalizeOptionalText(target.id, 'target.id');
  const name = normalizeOptionalText(target.name, 'target.name');
  const normalized = {
    ...(id ? { id } : {}),
    ...(name ? { name } : {}),
    ...(target.platform ? { platform: target.platform } : {}),
    ...(target.target ? { target: target.target } : {}),
    ...(target.headless !== undefined ? { headless: target.headless } : {}),
  };
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

// fallow-ignore-next-line complexity
function formatInstallResult(
  mode: 'install' | 'reinstall' | 'installFromSource',
  app: string | undefined,
  source: BackendInstallSource,
  result: BackendInstallResult,
): AdminInstallCommandResult {
  const backendResult = toBackendResult(result);
  const kind =
    mode === 'reinstall'
      ? 'appReinstalled'
      : mode === 'installFromSource'
        ? 'appInstalledFromSource'
        : 'appInstalled';
  const appName = readOptionalString(result, 'appName');
  const appId = readOptionalString(result, 'appId');
  const bundleId = readOptionalString(result, 'bundleId');
  const packageName = readOptionalString(result, 'packageName');
  const launchTarget = readOptionalString(result, 'launchTarget');
  const installablePath = readOptionalString(result, 'installablePath');
  const archivePath = readOptionalString(result, 'archivePath');
  return {
    kind,
    ...(app ? { app } : {}),
    source,
    ...(appId ? { appId } : {}),
    ...(appName ? { appName } : {}),
    ...(bundleId ? { bundleId } : {}),
    ...(packageName ? { packageName } : {}),
    ...(launchTarget ? { launchTarget } : {}),
    ...(installablePath ? { installablePath } : {}),
    ...(archivePath ? { archivePath } : {}),
    ...(backendResult ? { backendResult } : {}),
    ...successText(
      `${mode === 'reinstall' ? 'Reinstalled' : 'Installed'}: ${appName ?? launchTarget ?? app ?? formatSource(source)}`,
    ),
  };
}

function readOptionalString(record: Record<string, unknown>, field: string): string | undefined {
  const value = record[field];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function formatSource(source: BackendInstallSource): string {
  if (source.kind === 'path') return source.path;
  if (source.kind === 'uploadedArtifact') return source.id;
  return source.url;
}
