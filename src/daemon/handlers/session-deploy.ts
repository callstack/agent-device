import fs from 'node:fs';
import { cleanupUploadedArtifact, prepareUploadedArtifact } from '../artifact-tracking.ts';
import type { DeviceInfo } from '../../utils/device.ts';
import type { DaemonRequest, DaemonResponse } from '../types.ts';
import { SessionStore } from '../session-store.ts';
import { recordSessionAction } from './handler-utils.ts';
import { resolveDeployResultTarget } from '../../client-shared.ts';
import { withSuccessText } from '../../utils/success-text.ts';
import { requireSessionOrExplicitSelector, resolveCommandDevice } from './session-device-utils.ts';
import { errorResponse, requireCommandSupported } from './response.ts';

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
    const { reinstallIosApp } = await import('../../platforms/ios/apps.ts');
    return await reinstallIosApp(device, app, appPath);
  },
  android: async (device, app, appPath) => {
    const { reinstallAndroidApp } = await import('../../platforms/android/app-lifecycle.ts');
    return await reinstallAndroidApp(device, app, appPath);
  },
};

export const defaultInstallOps: InstallOps = {
  ios: async (device, app, appPath) => {
    const { installIosApp } = await import('../../platforms/ios/apps.ts');
    const result = await installIosApp(device, appPath, { appIdentifierHint: app });
    return {
      bundleId: result.bundleId,
      appName: result.appName,
      launchTarget: result.launchTarget,
    };
  },
  android: async (device, _app, appPath) => {
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
  const app = req.positionals?.[0]?.trim();
  const appPathInput = req.positionals?.[1]?.trim();
  if (!app || !appPathInput) {
    return errorResponse(
      'INVALID_ARGS',
      `${command} requires: ${command} <app> <path-to-app-binary>`,
    );
  }
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

    let result: DeployCommandResult;

    if (device.platform === 'ios') {
      const iosResult = await deployOps.ios(device, app, appPath);
      const bundleId = iosResult.bundleId;
      result = bundleId
        ? {
            app,
            appPath,
            platform: 'ios',
            appId: bundleId,
            bundleId,
            appName: iosResult.appName,
            launchTarget: iosResult.launchTarget,
          }
        : {
            app,
            appPath,
            platform: 'ios',
            appName: iosResult.appName,
            launchTarget: iosResult.launchTarget,
          };
    } else {
      const androidResult = await deployOps.android(device, app, appPath);
      const pkg = androidResult.package;
      result = pkg
        ? {
            app,
            appPath,
            platform: 'android',
            appId: pkg,
            package: pkg,
            packageName: pkg,
            appName: androidResult.appName,
            launchTarget: androidResult.launchTarget,
          }
        : {
            app,
            appPath,
            platform: 'android',
            appName: androidResult.appName,
            launchTarget: androidResult.launchTarget,
          };
    }

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
