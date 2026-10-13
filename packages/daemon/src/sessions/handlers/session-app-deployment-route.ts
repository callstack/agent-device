import type { DaemonPlatformServices } from '../../core/platform-services.ts';
import type {
  BindDeviceRuntime,
  InspectDeviceRuntimeFacts,
} from '../../core/request-runtime-binding.ts';
import { SessionStore } from '../../core/session-store.ts';
import type { DaemonRequest, DaemonResponse } from '../../core/daemon-request.ts';
import {
  handleAppDeploymentCommand,
  handlePushNotificationCommand,
} from './session-app-deployment.ts';
import { handleInstallFromSourceDeploymentCommand } from './session-app-source-deployment.ts';

/** The four canonical install-family descriptors share one daemon route boundary. */
export async function handleSessionAppDeploymentCommand(params: {
  req: DaemonRequest;
  sessionName: string;
  sessionStore: SessionStore;
  inspectFacts?: InspectDeviceRuntimeFacts;
  platformServices: DaemonPlatformServices;
  bindDevice?: BindDeviceRuntime;
}): Promise<DaemonResponse | null> {
  const { req, sessionName, sessionStore, inspectFacts, bindDevice, platformServices } = params;
  if (req.command === 'install' || req.command === 'reinstall') {
    return await handleAppDeploymentCommand({
      req,
      command: req.command,
      sessionName,
      sessionStore,
      inspectFacts,
      bindDevice,
      platformServices,
    });
  }
  if (req.command === 'install_source') {
    return await handleInstallFromSourceDeploymentCommand({
      req,
      sessionName,
      sessionStore,
      inspectFacts,
      bindDevice,
      platformServices,
    });
  }
  if (req.command === 'push') {
    return await handlePushNotificationCommand({
      req,
      sessionName,
      sessionStore,
      inspectFacts,
      bindDevice,
      platformServices,
    });
  }
  return null;
}
