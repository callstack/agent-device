import type { CloudWebDriverRuntimeOptions, CloudWebDriverRuntime } from './runtime.ts';

export async function createCloudWebDriverRuntime(
  options: CloudWebDriverRuntimeOptions,
): Promise<CloudWebDriverRuntime> {
  const runtime = await import('./runtime.ts');
  return runtime.createCloudWebDriverRuntime(options);
}
export type {
  CloudWebDriverRuntimeOptions,
  CloudWebDriverPlatform,
  CloudWebDriverUploadApp,
} from './runtime.ts';
export {
  appFileUploadForm,
  appendUrlPath,
  createHubUploadApp,
  fetchProviderSessionDetails,
  fetchProviderVerificationJson,
  postHubAppUpload,
  readFlag,
  requireEnv,
  requireFlag,
  requireProviderDeviceOrientation,
  requireRequest,
  requireRequestPlatform,
  resolveHubAppReference,
} from './webdriver-utils.ts';
export { cloudArtifactsReadyOrPending, urlArtifactFromDetails } from './artifact-results.ts';
export { buildCloudWebDriverBaseCapabilities } from './capabilities.ts';
