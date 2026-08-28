export { buildAppNotInstalledError } from './core/app-resolution-error.ts';
export {
  detectSoleRunningIosSimulatorApp,
  findIosSimulatorInstalledApp,
  invalidateIosAppResolutionCache,
  listIosApps,
  resolveIosApp,
  resolveIosAppAlias,
  resolveIosSimulatorDeepLinkBundleId,
} from './core/app-resolution.ts';
