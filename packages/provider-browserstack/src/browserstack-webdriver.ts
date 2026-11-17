import type { ProviderPluginHost } from 'agent-device/plugins';
import type { WebDriverPluginOptions } from 'agent-device/plugins/webdriver';
import {
  buildCloudWebDriverBaseCapabilities,
  readFlag,
  requireFlag,
  requireRequest,
  requireRequestPlatform,
} from '@agent-device/provider-webdriver/plugin';
import {
  BROWSERSTACK_APP_AUTOMATE_ENDPOINT,
  BROWSERSTACK_APP_UPLOAD_ENDPOINT,
  BROWSERSTACK_CAPABILITY_OVERRIDES,
  buildBrowserStackCapabilities,
  createBrowserStackUploadApp,
  listBrowserStackCloudArtifacts,
  resolveBrowserStackAppReference,
} from './browserstack.ts';
import {
  buildBrowserStackDeviceFeatureCapabilities,
  readBrowserStackDeviceFeatureFields,
} from './browserstack-device-features.ts';
import { BROWSERSTACK_PROFILE_FIELDS } from './profile-fields.ts';
import { PROVIDER, requireBrowserStackCredentials } from './providers.ts';

const SERVICE = 'BrowserStack';

/** The BrowserStack WebDriver descriptor the host drives through its shared engine. */
export function createBrowserStackWebDriver(host: ProviderPluginHost): WebDriverPluginOptions {
  const { env, clientVersion } = host;
  const webDriver: WebDriverPluginOptions = {
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
  return webDriver;
}
