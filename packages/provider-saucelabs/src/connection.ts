import type { ProviderPluginHost } from 'agent-device/plugins';
import type { CliFlags } from '@agent-device/contracts/command';
import {
  rejectRefusedProviderProfileFields,
  requireResolvedProfilePlatform,
  requireResolvedProfileValue,
} from '@agent-device/contracts/provider-profile-fields';
import {
  requireConnectFlag,
  requireConnectPlatform,
  resolveLocalAppArtifact,
} from '@agent-device/provider-webdriver/plugin';
import { SAUCE_LABS_PROFILE_FIELDS } from './profile-fields.ts';
import {
  isSauceLabsAppUrl,
  parseSauceLabsAppReference,
  readSauceLabsRegion,
  requireSauceLabsCredentials,
  SAUCE_LABS_PROVIDER,
  SAUCE_LABS_SERVICE,
} from './providers.ts';
import { readSauceLabsSessionFields } from './saucelabs.ts';
import { verifySauceLabsConnection } from './saucelabs-connection-verification.ts';

const CONSUMER = `connect ${SAUCE_LABS_PROVIDER}`;

/** The `connect saucelabs` callbacks: validate flags into a profile, then verify it read-only. */
export function createSauceLabsConnection(host: ProviderPluginHost) {
  return {
    resolve: ({ flags, cwd }: { flags: CliFlags; cwd: string }) => {
      rejectRefusedProviderProfileFields(flags, SAUCE_LABS_PROFILE_FIELDS);
      requireSauceLabsCredentials(host.env, CONSUMER);
      readSauceLabsRegion(host.env);
      const platform = requireConnectPlatform(flags, SAUCE_LABS_PROVIDER);
      const providerApp = connectAppReference(
        requireConnectFlag(
          flags.providerApp,
          SAUCE_LABS_PROVIDER,
          '--provider-app <storage:file-id, https URL, or local path>',
        ),
        cwd,
      );
      return {
        profile: {
          leaseProvider: SAUCE_LABS_PROVIDER,
          platform,
          device: requireConnectFlag(
            flags.device,
            SAUCE_LABS_PROVIDER,
            '--device <name, id, or pattern>',
          ),
          providerOsVersion: flags.providerOsVersion,
          providerApp,
          providerBuild: flags.providerBuild,
          providerSessionName: flags.providerSessionName,
          ...readSauceLabsSessionFields(flags, platform),
        } as const,
        // Verification reads these flags; it must see the canonical reference the profile saved.
        extraFlags: { providerApp },
      };
    },
    verify: async ({ flags }: { flags: CliFlags }) =>
      await verifySauceLabsConnection(
        {
          ...requireSauceLabsCredentials(host.env, CONSUMER),
          region: readSauceLabsRegion(host.env),
          platform: requireResolvedProfilePlatform(flags.platform, SAUCE_LABS_SERVICE),
          deviceName: requireResolvedProfileValue(
            flags.device,
            'Sauce Labs profile missed device.',
          ),
          ...(flags.providerOsVersion ? { osVersion: flags.providerOsVersion } : {}),
          app: requireResolvedProfileValue(flags.providerApp, 'Sauce Labs profile missed app.'),
        },
        host.clientVersion,
      ),
  };
}

/** A `storage:` reference is canonicalized, an https URL passes through, and anything else must be a local file. */
function connectAppReference(app: string, cwd: string): string {
  const reference = parseSauceLabsAppReference(app);
  if (reference) return reference.reference;
  return isSauceLabsAppUrl(app) ? app : resolveLocalAppArtifact(app, cwd, SAUCE_LABS_SERVICE);
}
