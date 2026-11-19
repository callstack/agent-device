import type { CliFlags } from '@agent-device/contracts/command';
import type { CloudWebDriverRuntimeOptions, CloudWebDriverRuntime } from './runtime.ts';

/** The context a hosted provider's `connect` resolve callback is called with. */
type HostedResolveContext<Host> = Readonly<{
  flags: CliFlags;
  stateDir: string;
  cwd: string;
  env: Readonly<Record<string, string | undefined>>;
  host: Host;
}>;

/** The context a hosted provider's `connect` verify callback is called with. */
type HostedVerifyContext<Host> = Readonly<{
  flags: CliFlags;
  env: Readonly<Record<string, string | undefined>>;
  host: Host;
}>;

/** The `connect` callbacks one provider's connection module owns. */
export type HostedConnection<Resolution, Verification, Host> = Readonly<{
  resolve(context: HostedResolveContext<Host>): Resolution | Promise<Resolution>;
  verify(context: HostedVerifyContext<Host>): Promise<Verification>;
}>;

/** Loads one provider's connection module for one host. */
export type HostedConnectionLoader<Resolution, Verification, Host> = (
  host: Host,
) =>
  | HostedConnection<Resolution, Verification, Host>
  | Promise<HostedConnection<Resolution, Verification, Host>>;

/**
 * Runs a hosted provider's `connect` resolve callback, loading that provider's connection module
 * for the host first. A plugin reaches this with `await import()` from inside its own callback, so
 * importing the plugin package for its declaration loads neither the engine nor the connection
 * code. The plugin's own loader keeps the credentials it was given on the host it builds.
 */
export async function resolveHostedConnection<Resolution, Verification, Host>(
  context: HostedResolveContext<Host>,
  loadConnection: HostedConnectionLoader<Resolution, Verification, Host>,
): Promise<Resolution> {
  const connection = await loadConnection(context.host);
  return await Promise.resolve(connection.resolve(context));
}

/** Runs the same provider's `connect` verify callback through the same lazy connection module. */
export async function verifyHostedConnection<Resolution, Verification, Host>(
  context: HostedVerifyContext<Host>,
  loadConnection: HostedConnectionLoader<Resolution, Verification, Host>,
): Promise<Verification> {
  const connection = await loadConnection(context.host);
  return await connection.verify(context);
}

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
  CloudWebDriverPrepareSession,
} from './runtime.ts';

/** The engine options a provider contributes; the host supplies `clientVersion`. */
export type CloudWebDriverProviderOptions = Omit<CloudWebDriverRuntimeOptions, 'clientVersion'>;

export type { CloudWebDriverCapabilityOverrides } from './capabilities.ts';
export {
  appFileUploadForm,
  appendUrlPath,
  createHubUploadApp,
  fetchProviderSessionDetails,
  fetchProviderVerificationJson,
  postHubAppUpload,
  readFlag,
  requireConnectFlag,
  requireConnectPlatform,
  requireEnv,
  requireFlag,
  requireProviderDeviceOrientation,
  requireRequest,
  requireRequestPlatform,
  releaseOnFailure,
  resolveHubAppReference,
  resolveLocalAppArtifact,
} from './webdriver-utils.ts';
export { cloudArtifactsReadyOrPending, urlArtifactFromDetails } from './artifact-results.ts';
export { buildCloudWebDriverBaseCapabilities } from './capabilities.ts';
export { sameOsVersion } from './webdriver-utils.ts';
