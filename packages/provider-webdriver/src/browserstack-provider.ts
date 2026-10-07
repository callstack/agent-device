import {
  BROWSERSTACK_APP_AUTOMATE_ENDPOINT,
  BROWSERSTACK_APP_UPLOAD_ENDPOINT,
  BROWSERSTACK_CAPABILITY_OVERRIDES,
  BROWSERSTACK_PROFILE_FIELDS,
  buildBrowserStackCapabilities,
  createBrowserStackUploadApp,
  listBrowserStackCloudArtifacts,
  requireBrowserStackCredentials,
  resolveBrowserStackAppReference,
} from './browserstack.ts';
import {
  buildBrowserStackDeviceFeatureCapabilities,
  readBrowserStackDeviceFeatureFields,
} from './browserstack-device-features.ts';
import { buildCloudWebDriverBaseCapabilities } from './capabilities.ts';
import type {
  BundledCloudWebDriverProvider,
  CloudWebDriverConnection,
  CloudWebDriverProviderHost,
  CloudWebDriverProviderOptions,
  CloudWebDriverProviderRegistration,
} from './provider-plugin.ts';
import { CLOUD_WEBDRIVER_PROVIDERS, cloudWebDriverProviderDeclaration } from './providers.ts';
import {
  readFlag,
  requireFlag,
  requireRequest,
  requireRequestPlatform,
} from './webdriver-utils.ts';

const PROVIDER = CLOUD_WEBDRIVER_PROVIDERS.browserStack;
const SERVICE = 'BrowserStack';

export const browserStackProvider: BundledCloudWebDriverProvider = {
  declaration: cloudWebDriverProviderDeclaration(PROVIDER)!,
  create: createBrowserStackProvider,
};

function createBrowserStackProvider(
  host: CloudWebDriverProviderHost,
): CloudWebDriverProviderRegistration {
  const { env, clientVersion } = host;
  const webDriver: CloudWebDriverProviderOptions = {
    provider: PROVIDER,
    profileFields: BROWSERSTACK_PROFILE_FIELDS,
    platform: 'android',
    deviceName: 'BrowserStack device',
    endpoint: env.BROWSERSTACK_WEBDRIVER_ENDPOINT ?? BROWSERSTACK_APP_AUTOMATE_ENDPOINT,
    capabilityOverrides: BROWSERSTACK_CAPABILITY_OVERRIDES,
    listArtifacts: async ({ provider, providerSessionId }) =>
      await listBrowserStackCloudArtifacts(provider, providerSessionId, {
        clientVersion,
        ...requireBrowserStackCredentials(env, 'BrowserStack artifact lookup'),
        endpoint: env.BROWSERSTACK_SESSION_DETAILS_ENDPOINT,
      }),
    prepareSession: async ({ req, lease, base }) => {
      const request = requireRequest(req, SERVICE);
      const credentials = requireBrowserStackCredentials(env, SERVICE);
      const platform = requireRequestPlatform(request, SERVICE);
      const deviceName = requireFlag(request, 'device', 'BrowserStack requires --device <name>.');
      const osVersion = requireFlag(
        request,
        'providerOsVersion',
        'BrowserStack requires --provider-os-version <version>.',
      );
      const upload = {
        clientVersion,
        ...credentials,
        endpoint: env.BROWSERSTACK_APP_UPLOAD_ENDPOINT ?? BROWSERSTACK_APP_UPLOAD_ENDPOINT,
      };
      const app = await resolveBrowserStackAppReference(
        requireFlag(
          request,
          'providerApp',
          'BrowserStack requires --provider-app <bs://app-id-or-local-path>.',
        ),
        // A local IPA/APK upload can run long (130 MB is routine); an upload is not a billed
        // resource, so the request's cancellation may simply abort it, unlike the session
        // creation that follows.
        { ...upload, cwd: request.cwd, signal: request.signal },
      );
      return {
        ...base,
        platform,
        deviceName,
        auth: credentials,
        uploadApp: createBrowserStackUploadApp(upload),
        webdriverCapabilities: buildBrowserStackCapabilities({
          deviceName,
          osVersion,
          app,
          projectName: readFlag(request, 'providerProject'),
          buildName: readFlag(request, 'providerBuild') ?? lease.runId,
          sessionName: readFlag(request, 'providerSessionName') ?? lease.leaseId,
          deviceFeatures: buildBrowserStackDeviceFeatureCapabilities(
            readBrowserStackDeviceFeatureFields(request.flags),
            platform,
          ),
          configured: buildCloudWebDriverBaseCapabilities(platform, deviceName),
        }),
      };
    },
  };
  const connect = async () =>
    (await import('./browserstack-connection.ts')).createBrowserStackConnection(host);
  const connection: CloudWebDriverConnection = {
    resolve: async (context) => (await connect()).resolve(context),
    verify: async (context) => await (await connect()).verify(context),
  };
  return { webDriver, connection };
}
