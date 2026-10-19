import type { DaemonResponse } from '@agent-device/kernel/contracts';
import type { HostEnvironment } from '@agent-device/kernel/source-value';
import type { DaemonPlatformServices } from '../../core/platform-services.ts';
import type {
  BindDeviceRuntime,
  InspectDeviceRuntimeFacts,
} from '../../core/request-runtime-binding.ts';
import { SessionStore } from '../../core/session-store.ts';
import type { DaemonRequest } from '../../core/daemon-request.ts';
import {
  handleAppDeploymentCommand,
  handlePushNotificationCommand,
  handleUninstallCommand,
} from './session-app-deployment.ts';
import { handleInstallFromSourceDeploymentCommand } from './session-app-source-deployment.ts';

/** The canonical install-family descriptors share one daemon route boundary. */
export async function handleSessionAppDeploymentCommand(params: {
  host: HostEnvironment;
  req: DaemonRequest;
  sessionName: string;
  sessionStore: SessionStore;
  inspectFacts?: InspectDeviceRuntimeFacts;
  platformServices: DaemonPlatformServices;
  bindDevice?: BindDeviceRuntime;
}): Promise<DaemonResponse | null> {
  const { host, req, sessionName, sessionStore, inspectFacts, bindDevice, platformServices } =
    params;
  if (req.command === 'install' || req.command === 'reinstall') {
    return await handleAppDeploymentCommand({
      host,
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
  if (req.command === 'uninstall') {
    return await handleUninstallCommand({
      host,
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
      host,
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
