import type {
  AppDeploymentResult,
  MaterializedAppSource,
} from '@agent-device/contracts/app-deployment-runtime';
import type { CommandFlags } from '@agent-device/contracts/command';
import { readyMaterializeAndDeployAppUse } from '@agent-device/contracts/app-deployment-runtime-plan';
import { isIosFamily } from '@agent-device/kernel/device';
import { AppError, normalizeError } from '@agent-device/kernel/errors';
import {
  cleanupRetainedMaterializedPaths,
  retainMaterializedPaths,
  type RetainedMaterializedPaths,
} from '../materialized-path-registry.ts';
import { expireRefFrame } from '../ref-frame.ts';
import { resolveInstallSource } from '../install-source-resolution.ts';
import type { BindDeviceRuntime, InspectDeviceRuntimeFacts } from '../request-runtime-binding.ts';
import { SessionStore } from '../session-store.ts';
import type { DaemonRequest, DaemonResponse, SessionState } from '../types.ts';
import { resolveInstallFromSourceResultTarget } from '../../utils/result-serialization.ts';
import { withSuccessText } from '@agent-device/kernel/success-text';
import { recordSessionAction } from './handler-utils.ts';
import { resolveCommandDevice } from './session-device-utils.ts';
import {
  requireRuntimeBinding,
  requireRuntimeFacts,
  unavailableRuntimeOperationResponse,
} from './session-runtime-admission.ts';

type Retention = Readonly<{ enabled: boolean; ttlMs?: number }>;
type InstallFromSourceResult = Readonly<{
  appName?: string;
  bundleId?: string;
  packageName?: string;
  launchTarget: string;
  archivePath?: string;
  installablePath?: string;
  materializationId?: string;
  materializationExpiresAt?: string;
}>;

export async function handleInstallFromSourceDeploymentCommand(params: {
  req: DaemonRequest;
  sessionName: string;
  sessionStore: SessionStore;
  inspectFacts?: InspectDeviceRuntimeFacts;
  bindDevice?: BindDeviceRuntime;
}): Promise<DaemonResponse> {
  const { req, sessionName, sessionStore } = params;
  const session = sessionStore.get(sessionName);
  let resolvedSource: ReturnType<typeof resolveInstallSource> | undefined;
  let materialized: MaterializedAppSource | undefined;
  let retained: RetainedMaterializedPaths | undefined;
  try {
    resolvedSource = resolveInstallSource(req);
    const retention = resolveRetention(req);
    const device = await resolveInstallDevice(session, req.flags);
    const facts = await requireRuntimeFacts(params.inspectFacts)(device);
    const unsupported =
      unavailableRuntimeOperationResponse('install_from_source', facts.operations.ensureReady) ??
      unavailableRuntimeOperationResponse(
        'install_from_source',
        facts.operations.materializeAppSource,
      ) ??
      unavailableRuntimeOperationResponse(
        'install_from_source',
        facts.operations.deployMaterializedApp,
      );
    if (unsupported) return unsupported;

    const runtime = await requireRuntimeBinding(params.bindDevice)(
      device,
      readyMaterializeAndDeployAppUse,
    );
    await runtime.operations.ensureReady({});
    materialized = await runtime.operations.materializeAppSource({ source: resolvedSource.source });
    retained = await retainIfRequested({
      artifact: materialized,
      retention,
      req,
      session,
      sessionName,
    });
    // ADR 0014 side-effect seam: materialization is request-local, but deployment can
    // replace the visible app surface. Expire immediately before its sole bound dispatch,
    // so admission or materialization failures preserve refs while a dispatch rejection does not.
    if (session) expireRefFrame(session);
    const deployment = await runtime.operations.deployMaterializedApp({ artifact: materialized });
    const result = buildInstallFromSourceResult(device, materialized, deployment, retained);
    const data = withSuccessText(
      result,
      `Installed: ${resolveInstallFromSourceResultTarget(result)}`,
    );
    recordSessionAction(sessionStore, session, req, 'install_source', data, { positionals: [] });
    return { ok: true, data };
  } catch (error) {
    if (retained) {
      await cleanupRetainedMaterializedPaths(retained.materializationId, req.meta?.tenantId).catch(
        () => {},
      );
    }
    return { ok: false, error: normalizeError(error) };
  } finally {
    await materialized?.cleanup();
    resolvedSource?.cleanup();
  }
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
    return { ok: true, data: { released: true, materializationId } };
  } catch (error) {
    return { ok: false, error: normalizeError(error) };
  }
}

async function resolveInstallDevice(
  session: SessionState | undefined,
  flags: DaemonRequest['flags'] | undefined,
): Promise<SessionState['device']> {
  const requestedPlatform = normalizePlatform(flags?.platform);
  if (session && requestedPlatform && session.device.platform !== requestedPlatform) {
    throw new AppError(
      'INVALID_ARGS',
      `install_from_source requested platform ${requestedPlatform}, but session is bound to ${session.device.platform}`,
    );
  }
  if (!session && !requestedPlatform) {
    throw new AppError(
      'INVALID_ARGS',
      'install_from_source requires platform "ios" or "android" when no session is provided',
    );
  }
  // Retain the established session contract: an existing session is already the
  // selected target, so request-bound readiness can use it directly without
  // re-enumerating inventory or reaching the legacy readiness adapter.
  if (session) {
    return session.device;
  }
  return await resolveCommandDevice({ session, flags, ensureReady: false });
}

function normalizePlatform(
  value: CommandFlags['platform'] | undefined,
): 'ios' | 'android' | undefined {
  return value === 'ios' || value === 'android' ? value : undefined;
}

function resolveRetention(req: DaemonRequest): Retention {
  const enabled = req.meta?.retainMaterializedPaths === true;
  const ttlMs = req.meta?.materializedPathRetentionMs;
  if (!enabled) return { enabled: false };
  if (ttlMs !== undefined && ttlMs <= 0) {
    throw new AppError(
      'INVALID_ARGS',
      'install_from_source retentionMs must be a positive integer',
    );
  }
  return { enabled: true, ...(ttlMs === undefined ? {} : { ttlMs }) };
}

async function retainIfRequested(params: {
  artifact: MaterializedAppSource;
  retention: Retention;
  req: DaemonRequest;
  session: SessionState | undefined;
  sessionName: string;
}): Promise<RetainedMaterializedPaths | undefined> {
  if (!params.retention.enabled) return undefined;
  return await retainMaterializedPaths({
    archivePath: params.artifact.archivePath,
    installablePath: params.artifact.installablePath,
    tenantId: params.req.meta?.tenantId,
    sessionName: params.session ? params.sessionName : undefined,
    ttlMs: params.retention.ttlMs,
  });
}

function buildInstallFromSourceResult(
  device: SessionState['device'],
  artifact: MaterializedAppSource,
  deployment: AppDeploymentResult,
  retained: RetainedMaterializedPaths | undefined,
): InstallFromSourceResult {
  if (isIosFamily(device)) {
    return buildIosInstallFromSourceResult(artifact, deployment, retained);
  }
  return buildAndroidInstallFromSourceResult(artifact, deployment, retained);
}

function buildIosInstallFromSourceResult(
  artifact: MaterializedAppSource,
  deployment: AppDeploymentResult,
  retained: RetainedMaterializedPaths | undefined,
): InstallFromSourceResult {
  const bundleId = deployment.bundleId ?? artifact.bundleId;
  if (!bundleId) {
    throw new AppError(
      'COMMAND_FAILED',
      'Installed iOS app identity could not be resolved from the artifact',
    );
  }
  return {
    ...retainedFields(retained),
    bundleId,
    ...deploymentAppName(deployment, artifact),
    launchTarget: deployment.launchTarget ?? bundleId,
  };
}

function buildAndroidInstallFromSourceResult(
  artifact: MaterializedAppSource,
  deployment: AppDeploymentResult,
  retained: RetainedMaterializedPaths | undefined,
): InstallFromSourceResult {
  const packageName = deployment.packageName ?? deployment.launchTarget ?? artifact.packageName;
  if (!packageName) {
    throw new AppError(
      'COMMAND_FAILED',
      'Installed Android app identity could not be resolved from the artifact or device state',
    );
  }
  return {
    ...retainedFields(retained),
    packageName,
    ...deploymentAppName(deployment, artifact),
    launchTarget: deployment.launchTarget ?? packageName,
  };
}

function deploymentAppName(deployment: AppDeploymentResult, artifact: MaterializedAppSource) {
  const appName = deployment.appName ?? artifact.appName;
  return appName ? { appName } : {};
}

function retainedFields(retained: RetainedMaterializedPaths | undefined) {
  if (!retained) return {};
  return {
    ...(retained.archivePath ? { archivePath: retained.archivePath } : {}),
    installablePath: retained.installablePath,
    materializationId: retained.materializationId,
    materializationExpiresAt: retained.expiresAt,
  };
}
