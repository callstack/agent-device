import type { ProviderPluginHost } from 'agent-device/plugins';
import type { WebDriverPluginOptions } from 'agent-device/plugins/webdriver';
import type { ProviderProfileFieldDeclaration } from '@agent-device/contracts/provider-profile-fields';
import type { ProviderDeviceType } from '@agent-device/contracts/remote';
import {
  buildCloudWebDriverBaseCapabilities,
  readFlag,
  requireEnv,
  requireFlag,
  requireRequest,
  requireRequestPlatform,
} from '@agent-device/provider-webdriver/plugin';
import { createTestMuConnection } from './connection.ts';
import {
  buildTestMuCapabilities,
  createTestMuUploadApp,
  listTestMuCloudArtifacts,
  resolveTestMuAppReference,
} from './testmu.ts';
import {
  buildTestMuDeviceFeatureCapabilities,
  readTestMuDeviceFeatureFields,
  readTestMuDeviceType,
} from './testmu-device-features.ts';
const TESTMU_WEBDRIVER_ENDPOINT = 'https://mobile-hub.lambdatest.com/wd/hub/';
const TESTMU_CAPABILITY_OVERRIDES = {
  install: {
    support: 'partial',
    note: 'Local app artifacts are uploaded to TestMu AI as real- or virtual-device apps (lt://), then installed with Appium.',
  },
  portReverse: {
    support: 'unsupported',
    note: 'Use the TestMu AI tunnel for network access to local hosts; agent-device port reverse is not available.',
  },
  artifacts: {
    support: 'supported',
    note: 'TestMu AI session details expose provider-hosted video, Appium logs, device logs, network logs, and dashboard links.',
  },
} as const;

const TESTMU_PROFILE_FIELDS: ProviderProfileFieldDeclaration = {
  provider: 'testmu',
  label: 'TestMu AI',
  fields: {
    providerApp: 'consumed',
    providerOsVersion: 'consumed',
    providerDeviceType: 'consumed',
    providerProject: 'consumed',
    providerBuild: 'consumed',
    providerSessionName: 'consumed',
    providerDeviceOrientation: 'consumed',
    providerGeoLocation: 'consumed',
    providerTimezone: 'consumed',
    providerAppiumVersion: 'consumed',
    providerLanguage: 'consumed',
    providerLocale: 'consumed',
    providerNetworkProfile: 'refused',
    providerCustomNetwork: 'refused',
    providerNoResignApp: 'refused',
    awsProjectArn: 'refused',
    awsDeviceArn: 'refused',
    awsAppArn: 'refused',
    awsRegion: 'refused',
    awsInteractionMode: 'refused',
  },
};

export default function testMuPlugin(host: ProviderPluginHost) {
  const env = host.env;
  async function listTestMuArtifactsFromEnv(
    provider: string,
    providerSessionId: string | undefined,
    env: ProviderPluginHost['env'],
  ) {
    return await listTestMuCloudArtifacts(provider, providerSessionId, {
      clientVersion: host.clientVersion,
      ...requireTestMuCredentials(env, 'TestMu AI artifact lookup'),
      endpoint: env.TESTMU_API_ENDPOINT,
    });
  }
  const webDriver: WebDriverPluginOptions = {
    provider: 'testmu',
    profileFields: TESTMU_PROFILE_FIELDS,
    platform: 'android',
    deviceName: 'TestMu AI device',
    endpoint: env.TESTMU_WEBDRIVER_ENDPOINT ?? TESTMU_WEBDRIVER_ENDPOINT,
    capabilityOverrides: TESTMU_CAPABILITY_OVERRIDES,
    listArtifacts: async ({ provider, providerSessionId }) =>
      await listTestMuArtifactsFromEnv(provider, providerSessionId, env),
    prepareSession: async ({ req, lease, base }) => {
      const request = requireRequest(req, 'TestMu AI');
      const deviceType = readTestMuDeviceType(request.flags);
      const uploadEndpoint = testMuAppUploadEndpoint(env, deviceType);
      const credentials = requireTestMuCredentials(env, 'TestMu AI');
      const platform = requireRequestPlatform(request, 'TestMu AI');
      const deviceName = requireFlag(request, 'device', 'TestMu AI requires --device <name>.');
      const osVersion = requireFlag(
        request,
        'providerOsVersion',
        'TestMu AI requires --provider-os-version <version>.',
      );
      const upload = {
        clientVersion: host.clientVersion,

        ...credentials,
        deviceType,
        endpoint: uploadEndpoint,
      };
      const app = await resolveTestMuAppReference(
        requireFlag(
          request,
          'providerApp',
          'TestMu AI requires --provider-app <lt://app-id, URL, or local path>.',
        ),
        { ...upload, cwd: request.cwd, signal: request.signal },
      );
      return {
        ...base,
        platform,
        deviceName,
        auth: credentials,
        uploadApp: createTestMuUploadApp(upload),
        webdriverCapabilities: buildTestMuCapabilities({
          platform,
          deviceType,
          deviceName,
          osVersion,
          app,
          projectName: readFlag(request, 'providerProject'),
          buildName: readFlag(request, 'providerBuild') ?? lease.runId,
          sessionName: readFlag(request, 'providerSessionName') ?? lease.leaseId,
          deviceFeatures: buildTestMuDeviceFeatureCapabilities(
            readTestMuDeviceFeatureFields(request.flags),
          ),
          configured: buildCloudWebDriverBaseCapabilities(platform, deviceName),
        }),
      };
    },
  };
  return { webDriver, connection: createTestMuConnection(host, TESTMU_PROFILE_FIELDS) };
}
function requireTestMuCredentials(
  env: ProviderPluginHost['env'],
  providerLabel: string,
): { username: string; accessKey: string } {
  return {
    username: requireEnv(env, 'LT_USERNAME', providerLabel),
    accessKey: requireEnv(env, 'LT_ACCESS_KEY', providerLabel),
  };
}

/** Each pool has its own upload API, so each has its own override. */
function testMuAppUploadEndpoint(
  env: ProviderPluginHost['env'],
  deviceType: ProviderDeviceType,
): string | undefined {
  return deviceType === 'real'
    ? env.TESTMU_REAL_DEVICE_APP_UPLOAD_ENDPOINT
    : env.TESTMU_APP_UPLOAD_ENDPOINT;
}
