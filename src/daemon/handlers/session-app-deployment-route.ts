import type { BindDeviceRuntime, InspectDeviceRuntimeFacts } from '../request-runtime-binding.ts';
import { SessionStore } from '../session-store.ts';
import type { DaemonRequest, DaemonResponse } from '../daemon-request.ts';
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
  bindDevice?: BindDeviceRuntime;
}): Promise<DaemonResponse | null> {
  const { req, sessionName, sessionStore, inspectFacts, bindDevice } = params;
  if (req.command === 'install' || req.command === 'reinstall') {
    return await handleAppDeploymentCommand({
      req,
      command: req.command,
      sessionName,
      sessionStore,
      inspectFacts,
      bindDevice,
    });
  }
  if (req.command === 'install_source') {
    return await handleInstallFromSourceDeploymentCommand({
      req,
      sessionName,
      sessionStore,
      inspectFacts,
      bindDevice,
    });
  }
  if (req.command === 'push') {
    return await handlePushNotificationCommand({
      req,
      sessionName,
      sessionStore,
      inspectFacts,
      bindDevice,
    });
  }
  return null;
}
