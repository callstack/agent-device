import type { ProviderPluginHost } from 'agent-device/plugins';
import type { CliFlags } from '@agent-device/contracts/command';
import {
  rejectRefusedProviderProfileFields,
  requireResolvedProfilePlatform,
  requireResolvedProfileValue,
  type ProviderProfileFieldDeclaration,
} from '@agent-device/contracts/provider-profile-fields';
import {
  requireConnectFlag,
  requireConnectPlatform,
  resolveLocalAppArtifact,
} from '@agent-device/provider-webdriver/plugin';
import {
  canonicalTestMuAppReference,
  isTestMuAppReference,
  requireTestMuCredentials,
} from './providers.ts';
import { verifyTestMuConnection } from './testmu-connection-verification.ts';
import { readTestMuDeviceFeatureFields, readTestMuDeviceType } from './testmu-device-features.ts';

const PROVIDER = 'testmu';
const SERVICE = 'TestMu AI';

export function createTestMuConnection(
  host: ProviderPluginHost,
  fields: ProviderProfileFieldDeclaration,
) {
  return {
    resolve: ({ flags, cwd }: { flags: CliFlags; cwd: string }) => {
      rejectRefusedProviderProfileFields(flags, fields);
      requireTestMuCredentials(host.env, `connect ${PROVIDER}`);
      const platform = requireConnectPlatform(flags, PROVIDER);
      const app = connectAppReference(
        requireConnectFlag(
          flags.providerApp,
          PROVIDER,
          '--provider-app <lt://app-id, URL, or local path>',
        ),
        cwd,
        host,
      );
      return {
        profile: {
          leaseProvider: PROVIDER,
          platform,
          device: requireConnectFlag(flags.device, PROVIDER, '--device <name>'),
          providerOsVersion: requireConnectFlag(
            flags.providerOsVersion,
            PROVIDER,
            '--provider-os-version <version>',
          ),
          providerApp: app,
          providerDeviceType: readTestMuDeviceType(flags),
          providerProject: flags.providerProject,
          providerBuild: flags.providerBuild,
          providerSessionName: flags.providerSessionName,
          ...readTestMuDeviceFeatureFields(flags),
        } as const,
        extraFlags: { providerApp: app },
      };
    },
    verify: async ({ flags }: { flags: CliFlags }) =>
      await verifyTestMuConnection(
        {
          provider: PROVIDER,
          ...requireTestMuCredentials(host.env, `connect ${PROVIDER}`),
          platform: requireResolvedProfilePlatform(flags.platform, SERVICE),
          deviceName: requireResolvedProfileValue(flags.device, 'TestMu AI profile missed device.'),
          osVersion: requireResolvedProfileValue(
            flags.providerOsVersion,
            'TestMu AI profile missed OS version.',
          ),
          app: canonicalTestMuAppReference(
            requireResolvedProfileValue(flags.providerApp, 'TestMu AI profile missed app.'),
          ),
          deviceType: readTestMuDeviceType(flags),
          apiEndpoint: host.env.TESTMU_API_ENDPOINT,
        },
        host.clientVersion,
      ),
  };
}

/** An `lt://` id is canonicalized, a public URL passes through, and anything else must be a local file. */
function connectAppReference(app: string, cwd: string, host: ProviderPluginHost): string {
  const reference = canonicalTestMuAppReference(app);
  if (reference.startsWith('lt://')) {
    if (isTestMuAppReference(reference)) return reference;
    throw host.createError('INVALID_ARGS', 'connect testmu requires a valid lt:// app reference.');
  }
  return /^https?:\/\//i.test(reference)
    ? reference
    : resolveLocalAppArtifact(reference, cwd, SERVICE);
}
