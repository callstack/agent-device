import { isIosFamily } from '../../kernel/device.ts';
import {
  installProviderDeviceInstallablePath,
  type ProviderDeviceInstallResult,
} from '../../provider-device-runtime.ts';
import { resolveTargetDevice, type CommandFlags } from '../../core/dispatch.ts';
import { ensureDeviceReady } from '../device-ready.ts';
import { getRequestSignal } from '../request-cancel.ts';
import {
  cleanupRetainedMaterializedPaths,
  retainMaterializedPaths,
  type RetainedMaterializedPaths,
} from '../materialized-path-registry.ts';
import { resolveInstallSource } from '../install-source-resolution.ts';
import { SessionStore } from '../session-store.ts';
import type { DaemonRequest, DaemonResponse, SessionState } from '../types.ts';

import { resolveInstallFromSourceResultTarget } from '../../client/client-shared.ts';
import { AppError, normalizeError } from '../../kernel/errors.ts';
import { withSuccessText } from '../../utils/success-text.ts';
import { requireCommandSupported } from './response.ts';
import { recordSessionAction } from './handler-utils.ts';

type PreparedInstallArtifact = {
  archivePath?: string;
  installablePath: string;
  cleanup(): Promise<void>;
};

type InstallFromSourceResult = {
  appName?: string;
  bundleId?: string;
  packageName?: string;
  launchTarget: string;
  archivePath?: string;
  installablePath?: string;
  materializationId?: string;
  materializationExpiresAt?: string;
};

type CompleteInstallFromSourceParams = {
  prepared: PreparedInstallArtifact;
  retention: ReturnType<typeof resolveRetainMaterializedPaths>;
  req: DaemonRequest;
  resolvedSourceCleanup: () => void;
  session: SessionState | undefined;
  sessionName: string;
  sessionStore: SessionStore;
  buildResult(retained: RetainedMaterializedPaths | undefined): Promise<InstallFromSourceResult>;
};

function normalizePlatform(platform: CommandFlags['platform']): 'ios' | 'android' | undefined {
  return platform === 'ios' || platform === 'android' ? platform : undefined;
}

function resolveRetainMaterializedPaths(req: DaemonRequest): { enabled: boolean; ttlMs?: number } {
  const enabled = req.meta?.retainMaterializedPaths === true;
  const ttlMs = req.meta?.materializedPathRetentionMs;
  if (!enabled) return { enabled: false };
  if (ttlMs !== undefined && ttlMs <= 0) {
    throw new AppError(
      'INVALID_ARGS',
      'install_from_source retentionMs must be a positive integer',
    );
  }
  return { enabled: true, ttlMs };
}

async function resolveInstallDevice(params: {
  session: SessionState | undefined;
  flags: DaemonRequest['flags'] | undefined;
}): Promise<SessionState['device']> {
  const requestedPlatform = normalizePlatform(params.flags?.platform);
  if (params.session) {
    if (requestedPlatform && params.session.device.platform !== requestedPlatform) {
      throw new AppError(
        'INVALID_ARGS',
        `install_from_source requested platform ${requestedPlatform}, but session is bound to ${params.session.device.platform}`,
      );
    }
    await ensureDeviceReady(params.session.device);
    return params.session.device;
  }

  if (!requestedPlatform) {
    throw new AppError(
      'INVALID_ARGS',
      'install_from_source requires platform "ios" or "android" when no session is provided',
    );
  }
  const device = await resolveTargetDevice(params.flags ?? {});
  await ensureDeviceReady(device);
  return device;
}

async function maybeRetainInstallArtifact(params: {
  prepared: PreparedInstallArtifact;
  retention: ReturnType<typeof resolveRetainMaterializedPaths>;
  req: DaemonRequest;
  session: SessionState | undefined;
  sessionName: string;
}): Promise<RetainedMaterializedPaths | undefined> {
  const { prepared, retention, req, session, sessionName } = params;
  if (!retention.enabled) {
    return undefined;
  }
  return await retainMaterializedPaths({
    archivePath: prepared.archivePath,
    installablePath: prepared.installablePath,
    tenantId: req.meta?.tenantId,
    sessionName: session ? sessionName : undefined,
    ttlMs: retention.ttlMs,
  });
}

function retainedInstallResultFields(retained: RetainedMaterializedPaths | undefined): {
  archivePath?: string;
  installablePath?: string;
  materializationId?: string;
  materializationExpiresAt?: string;
} {
  if (!retained) {
    return {};
  }
  return {
    ...(retained.archivePath ? { archivePath: retained.archivePath } : {}),
    installablePath: retained.installablePath,
    materializationId: retained.materializationId,
    materializationExpiresAt: retained.expiresAt,
  };
}

function recordInstallFromSourceAction(params: {
  session: SessionState | undefined;
  sessionStore: SessionStore;
  req: DaemonRequest;
  data: InstallFromSourceResult & Record<string, unknown>;
}): void {
  const { session, sessionStore, req, data } = params;
  recordSessionAction(sessionStore, session, req, 'install_source', data, { positionals: [] });
}

export async function handleInstallFromSourceCommand(params: {
  req: DaemonRequest;
  sessionName: string;
  sessionStore: SessionStore;
}): Promise<DaemonResponse> {
  const { req, sessionName, sessionStore } = params;
  const session = sessionStore.get(sessionName);
  try {
    const resolvedSource = resolveInstallSource(req);
    const retention = resolveRetainMaterializedPaths(req);
    const device = await resolveInstallDevice({
      session,
      flags: req.flags,
    });
    const unsupported = requireCommandSupported('install', device, {
      message: 'install_from_source is not supported on this device',
    });
    if (unsupported) return unsupported;

    const requestSignal = getRequestSignal(req.meta?.requestId);
    if (isIosFamily(device)) {
      const { prepareIosInstallArtifact } =
        await import('../../platforms/apple/core/install-artifact.ts');
      const prepared = await prepareIosInstallArtifact(resolvedSource.source, {
        signal: requestSignal,
      });
      return await completeInstallFromSource({
        prepared,
        retention,
        req,
        resolvedSourceCleanup: () => resolvedSource.cleanup(),
        session,
        sessionName,
        sessionStore,
        buildResult: async (retained) =>
          await installPreparedIosArtifact(device, prepared, retained),
      });
    }

    const { prepareAndroidInstallArtifact } =
      await import('../../platforms/android/install-artifact.ts');
    const prepared = await prepareAndroidInstallArtifact(resolvedSource.source, {
      signal: requestSignal,
    });
    return await completeInstallFromSource({
      prepared,
      retention,
      req,
      resolvedSourceCleanup: () => resolvedSource.cleanup(),
      session,
      sessionName,
      sessionStore,
      buildResult: async (retained) =>
        await installPreparedAndroidArtifact(device, prepared, retained),
    });
  } catch (error) {
    const normalized = normalizeError(error);
    return { ok: false, error: normalized };
  }
}

async function completeInstallFromSource(
  params: CompleteInstallFromSourceParams,
): Promise<DaemonResponse> {
  let retained: RetainedMaterializedPaths | undefined;
  try {
    retained = await maybeRetainInstallArtifact(params);
    const result = await params.buildResult(retained);
    const data = withSuccessText(result, buildInstallFromSourceMessage(result));
    recordInstallFromSourceAction({
      session: params.session,
      sessionStore: params.sessionStore,
      req: params.req,
      data,
    });
    return { ok: true, data };
  } catch (error) {
    if (retained) {
      await cleanupRetainedMaterializedPaths(
        retained.materializationId,
        params.req.meta?.tenantId,
      ).catch(() => {});
    }
    throw error;
  } finally {
    await params.prepared.cleanup();
    params.resolvedSourceCleanup();
  }
}

async function installPreparedIosArtifact(
  device: SessionState['device'],
  prepared: PreparedInstallArtifact & { bundleId?: string; appName?: string },
  retained: RetainedMaterializedPaths | undefined,
): Promise<InstallFromSourceResult> {
  const providerResult = await installProviderDeviceInstallablePath(
    device,
    prepared.installablePath,
    { appIdentifierHint: prepared.bundleId },
  );
  if (!providerResult) {
    const { installIosInstallablePath } = await import('../../platforms/apple/core/apps.ts');
    await installIosInstallablePath(device, prepared.installablePath);
  }
  return buildIosInstallFromSourceResult(prepared, providerResult, retained);
}

async function installPreparedAndroidArtifact(
  device: SessionState['device'],
  prepared: PreparedInstallArtifact & { packageName?: string },
  retained: RetainedMaterializedPaths | undefined,
): Promise<InstallFromSourceResult> {
  const providerResult = await installProviderDeviceInstallablePath(
    device,
    prepared.installablePath,
    { packageNameHint: prepared.packageName },
  );
  const packageName = await resolveAndroidPackageName(device, prepared, providerResult);
  const { inferAndroidAppName } = await import('../../platforms/android/app-lifecycle.ts');
  const appName = inferAndroidAppName(packageName);
  return {
    ...retainedInstallResultFields(retained),
    packageName,
    ...optionalAppNameField(providerResult?.appName ?? appName),
    launchTarget: providerResult?.launchTarget ?? packageName,
  };
}

function buildIosInstallFromSourceResult(
  prepared: PreparedInstallArtifact & { bundleId?: string; appName?: string },
  providerResult: ProviderDeviceInstallResult | undefined,
  retained: RetainedMaterializedPaths | undefined,
): InstallFromSourceResult {
  const bundleId = resolveIosBundleId(prepared, providerResult);
  const appName = providerResult?.appName ?? prepared.appName;
  return {
    ...retainedInstallResultFields(retained),
    bundleId,
    ...optionalAppNameField(appName),
    launchTarget: providerResult?.launchTarget ?? bundleId,
  };
}

function resolveIosBundleId(
  prepared: PreparedInstallArtifact & { bundleId?: string },
  providerResult: ProviderDeviceInstallResult | undefined,
): string {
  const bundleId = providerResult?.bundleId ?? prepared.bundleId;
  if (bundleId) return bundleId;
  throw new AppError(
    'COMMAND_FAILED',
    'Installed iOS app identity could not be resolved from the artifact',
  );
}

function optionalAppNameField(appName: string | undefined): { appName?: string } {
  return appName ? { appName } : {};
}

async function resolveAndroidPackageName(
  device: SessionState['device'],
  prepared: PreparedInstallArtifact & { packageName?: string },
  providerResult: ProviderDeviceInstallResult | undefined,
): Promise<string> {
  const providerPackageName = providerResult?.packageName ?? providerResult?.launchTarget;
  if (providerPackageName) {
    return providerPackageName;
  }
  const { installAndroidInstallablePathAndResolvePackageName } =
    await import('../../platforms/android/app-lifecycle.ts');
  const packageName = await installAndroidInstallablePathAndResolvePackageName(
    device,
    prepared.installablePath,
    prepared.packageName,
  );
  if (!packageName) {
    throw new AppError(
      'COMMAND_FAILED',
      'Installed Android app identity could not be resolved from the artifact or device state',
    );
  }
  return packageName;
}

function buildInstallFromSourceMessage(result: {
  appName?: string;
  bundleId?: string;
  packageName?: string;
  launchTarget: string;
}): string {
  return `Installed: ${resolveInstallFromSourceResultTarget(result)}`;
}

export async function handleReleaseMaterializedPathsCommand(params: {
  req: DaemonRequest;
}): Promise<DaemonResponse> {
  const { req } = params;
  try {
    const materializationId = req.meta?.materializationId?.trim();
    if (!materializationId) {
      throw new AppError('INVALID_ARGS', 'release_materialized_paths requires a materializationId');
    }
    await cleanupRetainedMaterializedPaths(materializationId, req.meta?.tenantId);
    return {
      ok: true,
      data: {
        released: true,
        materializationId,
      },
    };
  } catch (error) {
    return { ok: false, error: normalizeError(error) };
  }
}
