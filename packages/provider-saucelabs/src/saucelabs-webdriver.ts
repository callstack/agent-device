import type { ProviderPluginHost } from 'agent-device/plugins';
import type { WebDriverPluginOptions } from 'agent-device/plugins/webdriver';
import {
  buildCloudWebDriverBaseCapabilities,
  readFlag,
  requireFlag,
  requireRequest,
  requireRequestPlatform,
} from '@agent-device/provider-webdriver/plugin';
import { SAUCE_LABS_PROFILE_FIELDS } from './profile-fields.ts';
import {
  readSauceLabsRegion,
  requireSauceLabsCredentials,
  SAUCE_LABS_PROVIDER,
  SAUCE_LABS_SERVICE,
  sauceLabsWebDriverEndpoint,
} from './providers.ts';
import {
  buildSauceLabsCapabilities,
  createSauceLabsUploadApp,
  describeSauceLabsSession,
  listSauceLabsCloudArtifacts,
  readSauceLabsSessionFields,
  resolveSauceLabsAppReference,
  SAUCE_LABS_CAPABILITY_OVERRIDES,
} from './saucelabs.ts';

/** The Sauce Labs WebDriver descriptor the host drives through its shared engine. */
export function createSauceLabsWebDriver(host: ProviderPluginHost): WebDriverPluginOptions {
  const { env, clientVersion } = host;
  const api = (consumer: string) => ({
    clientVersion,
    region: readSauceLabsRegion(env),
    ...requireSauceLabsCredentials(env, consumer),
  });
  return {
    provider: SAUCE_LABS_PROVIDER,
    profileFields: SAUCE_LABS_PROFILE_FIELDS,
    platform: 'android',
    deviceName: 'Sauce Labs device',
    endpoint: sauceLabsWebDriverEndpoint('us-west-1'),
    capabilityOverrides: SAUCE_LABS_CAPABILITY_OVERRIDES,
    // A job looked up by id alone, with no session this runtime prepared, is in the SAUCE_REGION data center.
    listArtifacts: async ({ provider, providerSessionId }) =>
      await listSauceLabsCloudArtifacts(
        provider,
        providerSessionId,
        api('Sauce Labs artifact lookup'),
      ),
    prepareSession: async ({ req, lease, base }) => {
      const request = requireRequest(req, SAUCE_LABS_SERVICE);
      const platform = requireRequestPlatform(request, SAUCE_LABS_SERVICE);
      const options = api(SAUCE_LABS_SERVICE);
      const deviceName = requireFlag(request, 'device', 'Sauce Labs requires --device <name>.');
      const sessionFields = readSauceLabsSessionFields(request.flags, platform);
      const app = await resolveSauceLabsAppReference(
        requireFlag(
          request,
          'providerApp',
          'Sauce Labs requires --provider-app <storage:file-id, https URL, or local path>.',
        ),
        // An upload is not a billed resource, so the request's cancellation may abort it.
        { ...options, cwd: request.cwd, signal: request.signal },
      );
      return {
        ...base,
        endpoint: sauceLabsWebDriverEndpoint(options.region),
        platform,
        deviceName,
        auth: { username: options.username, accessKey: options.accessKey },
        uploadApp: createSauceLabsUploadApp(options),
        describeCreatedSession: describeSauceLabsSession,
        // Job details live in the session's data center, so the lookup is bound to it here.
        listArtifacts: async ({ provider, providerSessionId }) =>
          await listSauceLabsCloudArtifacts(provider, providerSessionId, options),
        webdriverCapabilities: buildSauceLabsCapabilities({
          platform,
          deviceName,
          osVersion: readFlag(request, 'providerOsVersion'),
          app,
          buildName: readFlag(request, 'providerBuild') ?? lease.runId,
          sessionName: readFlag(request, 'providerSessionName') ?? lease.leaseId,
          ...sessionFields,
          base: buildCloudWebDriverBaseCapabilities(platform, deviceName),
        }),
      };
    },
  };
}
