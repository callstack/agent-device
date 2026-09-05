export { buildAppNotInstalledError } from './core/app-resolution-error.ts';
export {
  detectSoleRunningIosSimulatorApp,
  findIosSimulatorInstalledApp,
  invalidateIosAppResolutionCache,
  resolveIosApp,
  resolveIosAppAlias,
  resolveIosSimulatorDeepLinkBundleId,
} from './core/app-resolution.ts';
