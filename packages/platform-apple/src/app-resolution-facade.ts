export { buildAppNotInstalledError } from './core/app-resolution-error.ts';
export {
  detectSoleRunningIosSimulatorApp,
  findIosSimulatorInstalledApp,
  invalidateIosAppResolutionCache,
  resolveIosApp,
  resolveIosSimulatorDeepLinkBundleId,
  resolveMacOsAppDeviceOpenTarget,
} from './core/app-resolution.ts';
