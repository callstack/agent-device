import fs from 'node:fs';
import type { AppDeploymentResult } from '@agent-device/contracts/app-deployment-runtime';
import {
  deployAppUse,
  readySendPushNotificationUse,
} from '@agent-device/contracts/app-deployment-runtime-plan';
import { isIosFamily, publicPlatformString } from '@agent-device/kernel/device';
import { readNotificationPayload } from '../../core/dispatch-payload.ts';
import { cleanupUploadedArtifact, prepareUploadedArtifact } from '../artifact-tracking.ts';
import { expireRefFrame } from '../ref-frame.ts';
import type { BindDeviceRuntime, InspectDeviceRuntimeFacts } from '../request-runtime-binding.ts';
import { SessionStore } from '../session-store.ts';
import type { DaemonRequest, DaemonResponse, SessionState } from '../types.ts';
import { resolvePayloadInput } from '../../utils/payload-input.ts';
import { resolveDeployResultTarget } from '../../utils/result-serialization.ts';
import { withSuccessText } from '@agent-device/kernel/success-text';
import { recordSessionAction } from './handler-utils.ts';
import { errorResponse } from '../response.ts';
import {
  requireSessionOrExplicitSelector,
  resolveCommandDevice,
} from '../session-device-resolution.ts';
import {
  requireRuntimeBinding,
  requireRuntimeFacts,
  type RuntimeCommandHandlerParams,
  unavailableRuntimeOperationResponse,
} from '../session-runtime-admission.ts';

type DeployCommand = 'install' | 'reinstall';

type DeployResult = Readonly<{
  app: string;
  appPath: string;
  appName?: string;
  appId?: string;
  bundleId?: string;
  package?: string;
  packageName?: string;
  launchTarget?: string;
  platform: 'ios' | 'android' | 'harmonyos';
}>;

export async function handleAppDeploymentCommand(params: {
  req: DaemonRequest;
  command: DeployCommand;
  sessionName: string;
  sessionStore: SessionStore;
  inspectFacts?: InspectDeviceRuntimeFacts;
  bindDevice?: BindDeviceRuntime;
}): Promise<DaemonResponse> {
  const { req, command, sessionName, sessionStore } = params;
  const session = sessionStore.get(sessionName);
  const flags = req.flags ?? {};
  const guard = requireSessionOrExplicitSelector(command, session, flags);
  if (guard) return guard;
  const target = resolveDeployTarget(command, req.positionals ?? []);
  if (!target.ok) return target.response;

  const uploadedArtifactId = req.meta?.uploadedArtifactId;
  try {
    const appPath = uploadedArtifactId
      ? prepareUploadedArtifact(uploadedArtifactId, req.meta?.tenantId)
      : SessionStore.expandHome(target.appPathInput);
    if (!fs.existsSync(appPath)) {
      return errorResponse('INVALID_ARGS', `App binary not found: ${appPath}`);
    }

    const device = await resolveCommandDevice({ session, flags, ensureReady: false });
    const facts = await requireRuntimeFacts(params.inspectFacts)(device);
    const unsupported = unavailableRuntimeOperationResponse(command, facts.operations.deployApp);
    if (unsupported) return unsupported;

    const runtime = await requireRuntimeBinding(params.bindDevice)(device, deployAppUse);
    // ADR 0014: deployment can replace the visible surface. Do this immediately before the
    // bound operation so an admission failure never discards a still-valid reference frame.
    if (session) expireRefFrame(session);
    const deployment = await runtime.operations.deployApp({
      app: target.app,
      appPath,
      replaceExisting: command === 'reinstall',
    });
    const result = buildDeployResult(device, target.app, appPath, deployment);
    const data = withSuccessText(
      result,
      `Installed: ${result.appName ?? resolveDeployResultTarget(result)}`,
    );
    const sessionForRecord = updateHarmonyDeploymentSession(session, result);
    if (sessionForRecord && sessionForRecord !== session) {
      sessionStore.set(sessionName, sessionForRecord);
    }
    recordSessionAction(sessionStore, sessionForRecord, req, command, data);
    return { ok: true, data };
  } finally {
    if (uploadedArtifactId) cleanupUploadedArtifact(uploadedArtifactId);
  }
}

export async function handlePushNotificationCommand(
  params: RuntimeCommandHandlerParams,
): Promise<DaemonResponse> {
  const { req, sessionName, sessionStore } = params;
  const session = sessionStore.get(sessionName);
  const flags = req.flags ?? {};
  const guard = requireSessionOrExplicitSelector('push', session, flags);
  if (guard) return guard;

  const appId = req.positionals?.[0]?.trim();
  const payloadArg = req.positionals?.[1]?.trim();
  if (!appId || !payloadArg) {
    return errorResponse(
      'INVALID_ARGS',
      'push requires <bundle|package> <payload.json|inline-json>',
    );
  }
  const payload = await readNotificationPayload(resolvePushPayload(payloadArg, req.meta?.cwd));
  const device = await resolveCommandDevice({ session, flags, ensureReady: false });
  const facts = await requireRuntimeFacts(params.inspectFacts)(device);
  const unsupported =
    unavailableRuntimeOperationResponse('push', facts.operations.ensureReady) ??
    unavailableRuntimeOperationResponse('push', facts.operations.sendPushNotification);
  if (unsupported) return unsupported;

  const runtime = await requireRuntimeBinding(params.bindDevice)(
    device,
    readySendPushNotificationUse,
  );
  await runtime.operations.ensureReady({});
  // ADR 0014: a notification dispatch may change the visible surface. Keep an admission failure
  // non-destructive, but expire immediately before dispatch so an attempted provider operation
  // that fails after crossing the side-effect seam cannot leave stale refs authorized.
  if (session) expireRefFrame(session);
  const result = await runtime.operations.sendPushNotification({ appId, payload });
  const data = isIosFamily(device)
    ? withSuccessText({ platform: 'ios', bundleId: appId }, `Pushed notification to ${appId}`)
    : withSuccessText(
        {
          platform: publicPlatformString(device),
          package: appId,
          action: result.action,
          extrasCount: result.extrasCount,
        },
        `Pushed notification to ${appId}`,
      );
  recordSessionAction(sessionStore, session, req, 'push', data, {
    positionals: [appId, payloadArg],
  });
  return { ok: true, data };
}

function buildDeployResult(
  device: SessionState['device'],
  app: string,
  appPath: string,
  deployment: AppDeploymentResult,
): DeployResult {
  // This response normalization remains daemon-owned; platform runtimes own the mechanics.
  if (isIosFamily(device)) {
    return buildIosDeployResult(app, appPath, deployment);
  }
  return buildNonIosDeployResult(device, app, appPath, deployment);
}

function buildIosDeployResult(
  app: string,
  appPath: string,
  deployment: AppDeploymentResult,
): DeployResult {
  const bundleId = deployment.bundleId;
  return {
    app: app || bundleId || deployment.launchTarget || appPath,
    appPath,
    platform: 'ios',
    ...(bundleId ? { appId: bundleId, bundleId } : {}),
    appName: deployment.appName,
    launchTarget: deployment.launchTarget,
  };
}

function buildNonIosDeployResult(
  device: SessionState['device'],
  app: string,
  appPath: string,
  deployment: AppDeploymentResult,
): DeployResult {
  const packageName = deployment.packageName;
  const platform = device.platform === 'harmonyos' ? 'harmonyos' : 'android';
  return {
    app: app || packageName || deployment.launchTarget || appPath,
    appPath,
    platform,
    ...(packageName ? { appId: packageName, package: packageName, packageName } : {}),
    appName: deployment.appName,
    launchTarget: deployment.launchTarget,
  };
}

function updateHarmonyDeploymentSession(
  session: SessionState | undefined,
  result: DeployResult,
): SessionState | undefined {
  if (!session || result.platform !== 'harmonyos' || !result.appId) return session;
  return {
    ...session,
    appBundleId: result.appId,
    appName: result.appName ?? result.app,
  };
}

function resolveDeployTarget(
  command: DeployCommand,
  positionals: string[],
):
  | Readonly<{ ok: true; app: string; appPathInput: string }>
  | Readonly<{ ok: false; response: DaemonResponse }> {
  const first = positionals[0]?.trim();
  const second = positionals[1]?.trim();
  if (command === 'install') {
    const appPathInput = second ?? first;
    if (!appPathInput) {
      return {
        ok: false,
        response: errorResponse('INVALID_ARGS', 'install requires: install <path-to-app-binary>'),
      };
    }
    return { ok: true, app: second ? (first ?? '') : '', appPathInput };
  }
  if (!first || !second) {
    return {
      ok: false,
      response: errorResponse(
        'INVALID_ARGS',
        'reinstall requires: reinstall <app> <path-to-app-binary>',
      ),
    };
  }
  return { ok: true, app: first, appPathInput: second };
}

function resolvePushPayload(payloadArg: string, cwd?: string): string {
  const resolved = resolvePayloadInput(payloadArg, {
    subject: 'Push payload',
    cwd,
    expandPath: (value, currentCwd) => SessionStore.expandHome(value, currentCwd),
  });
  return resolved.kind === 'file' ? resolved.path : resolved.text;
}
