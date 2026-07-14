import fs from 'node:fs';
import { installProviderDeviceApp } from '../../provider-device-runtime.ts';
import { cleanupUploadedArtifact, prepareUploadedArtifact } from '../artifact-tracking.ts';
import { isIosFamily, type DeviceInfo } from '../../kernel/device.ts';
import type { DaemonRequest, DaemonResponse } from '../types.ts';
import { SessionStore } from '../session-store.ts';
import { recordSessionAction } from './handler-utils.ts';
import { resolveDeployResultTarget } from '../../contracts/result-serialization.ts';
import { withSuccessText } from '../../utils/success-text.ts';
import { requireSessionOrExplicitSelector, resolveCommandDevice } from './session-device-utils.ts';
import { errorResponse, requireCommandSupported } from './response.ts';
import { expireRefFrame } from '../ref-frame.ts';

export type ReinstallOps = {
  ios: (device: DeviceInfo, app: string, appPath: string) => Promise<{ bundleId: string }>;
  android: (device: DeviceInfo, app: string, appPath: string) => Promise<{ package: string }>;
};

export type AppDeployOps = {
  ios: (
    device: DeviceInfo,
    app: string,
    appPath: string,
  ) => Promise<{ bundleId?: string; appName?: string; launchTarget?: string }>;
  android: (
    device: DeviceInfo,
    app: string,
    appPath: string,
  ) => Promise<{ package?: string; appName?: string; launchTarget?: string }>;
};

export type InstallOps = AppDeployOps;

type DeployCommandResultBase = {
  app: string;
  appPath: string;
  appName?: string;
  launchTarget?: string;
};

type IosDeployCommandResult = DeployCommandResultBase & {
  platform: 'ios';
  appId?: string;
  bundleId?: string;
};

type AndroidDeployCommandResult = DeployCommandResultBase & {
  platform: 'android';
  appId?: string;
  package?: string;
  packageName?: string;
};

type DeployCommandResult = IosDeployCommandResult | AndroidDeployCommandResult;

export const defaultReinstallOps: ReinstallOps = {
  ios: async (device, app, appPath) => {
    const providerResult = await installProviderDeviceApp(device, app, appPath, {
      relaunch: true,
      appIdentifierHint: app,
    });
    if (providerResult) {
      return { bundleId: providerResult.bundleId ?? providerResult.launchTarget ?? app };
    }

    const { reinstallIosApp } = await import('../../platforms/apple/core/apps.ts');
    return await reinstallIosApp(device, app, appPath);
  },
  android: async (device, app, appPath) => {
    const providerResult = await installProviderDeviceApp(device, app, appPath, {
      relaunch: true,
      packageNameHint: app,
    });
    if (providerResult) {
      return { package: providerResult.packageName ?? providerResult.launchTarget ?? app };
    }

    const { reinstallAndroidApp } = await import('../../platforms/android/app-lifecycle.ts');
    return await reinstallAndroidApp(device, app, appPath);
  },
};

export const defaultInstallOps: InstallOps = {
  ios: async (device, app, appPath) => {
    const providerResult = await installProviderDeviceApp(device, app, appPath, {
      appIdentifierHint: app,
    });
    if (providerResult) {
      return {
        bundleId: providerResult.bundleId,
        appName: providerResult.appName,
        launchTarget: providerResult.launchTarget,
      };
    }

    const { installIosApp } = await import('../../platforms/apple/core/apps.ts');
    const result = await installIosApp(device, appPath, { appIdentifierHint: app });
    return {
      bundleId: result.bundleId,
      appName: result.appName,
      launchTarget: result.launchTarget,
    };
  },
  android: async (device, _app, appPath) => {
    const providerResult = await installProviderDeviceApp(device, _app, appPath, {
      packageNameHint: _app,
    });
    if (providerResult) {
      return {
        package: providerResult.packageName,
        appName: providerResult.appName,
        launchTarget: providerResult.launchTarget,
      };
    }

    const { installAndroidApp } = await import('../../platforms/android/app-lifecycle.ts');
    const result = await installAndroidApp(device, appPath);
    return {
      package: result.packageName,
      appName: result.appName,
      launchTarget: result.launchTarget,
    };
  },
};

export async function handleAppDeployCommand(params: {
  req: DaemonRequest;
  command: 'install' | 'reinstall';
  sessionName: string;
  sessionStore: SessionStore;
  deployOps: AppDeployOps;
}): Promise<DaemonResponse> {
  const { req, command, sessionName, sessionStore, deployOps } = params;
  const session = sessionStore.get(sessionName);
  const flags = req.flags ?? {};
  const guard = requireSessionOrExplicitSelector(command, session, flags);
  if (guard) return guard;
  const deployTarget = resolveDeployTarget(command, req.positionals ?? []);
  if (!deployTarget.ok) return deployTarget.response;
  const { app, appPathInput } = deployTarget;
  const uploadedArtifactId = req.meta?.uploadedArtifactId;

  try {
    const appPath = uploadedArtifactId
      ? prepareUploadedArtifact(uploadedArtifactId, req.meta?.tenantId)
      : SessionStore.expandHome(appPathInput);
    if (!fs.existsSync(appPath)) {
      return errorResponse('INVALID_ARGS', `App binary not found: ${appPath}`);
    }
    const device = await resolveCommandDevice({
      session,
      flags,
      ensureReady: false,
    });
    const unsupported = requireCommandSupported(command, device);
    if (unsupported) return unsupported;

    // ADR 0014 side-effect seam: install/reinstall replace the app binary and
    // can replace the visible surface; expire the frame before the deploy op.
    if (session) expireRefFrame(session);

    const result = isIosFamily(device)
      ? buildIosDeployResult(app, appPath, await deployOps.ios(device, app, appPath))
      : buildAndroidDeployResult(app, appPath, await deployOps.android(device, app, appPath));

    const data = withSuccessText(result, buildDeployMessage(result));
    recordSessionAction(sessionStore, session, req, command, data);
    return { ok: true, data };
  } finally {
    if (uploadedArtifactId) {
      cleanupUploadedArtifact(uploadedArtifactId);
    }
  }
}

function buildDeployMessage(result: DeployCommandResult): string {
  return `Installed: ${result.appName ?? resolveDeployResultTarget(result)}`;
}

function buildIosDeployResult(
  app: string,
  appPath: string,
  iosResult: Awaited<ReturnType<AppDeployOps['ios']>>,
): IosDeployCommandResult {
  const bundleId = iosResult.bundleId;
  const resultApp = app || bundleId || iosResult.launchTarget || appPath;
  return {
    app: resultApp,
    appPath,
    platform: 'ios',
    ...(bundleId ? { appId: bundleId, bundleId } : {}),
    appName: iosResult.appName,
    launchTarget: iosResult.launchTarget,
  };
}

function buildAndroidDeployResult(
  app: string,
  appPath: string,
  androidResult: Awaited<ReturnType<AppDeployOps['android']>>,
): AndroidDeployCommandResult {
  const pkg = androidResult.package;
  const resultApp = app || pkg || androidResult.launchTarget || appPath;
  return {
    app: resultApp,
    appPath,
    platform: 'android',
    ...(pkg ? { appId: pkg, package: pkg, packageName: pkg } : {}),
    appName: androidResult.appName,
    launchTarget: androidResult.launchTarget,
  };
}

function resolveDeployTarget(
  command: 'install' | 'reinstall',
  positionals: string[],
): { ok: true; app: string; appPathInput: string } | { ok: false; response: DaemonResponse } {
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
