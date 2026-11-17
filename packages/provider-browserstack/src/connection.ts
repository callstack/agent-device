import type { PluginConnection, ProviderPluginHost } from 'agent-device/plugins';
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
import { parseBrowserStackAppReference } from './browserstack.ts';
import { readBrowserStackDeviceFeatureFields } from './browserstack-device-features.ts';
import { BROWSERSTACK_PROFILE_FIELDS } from './profile-fields.ts';
import { PROVIDER, requireBrowserStackCredentials } from './providers.ts';
import { verifyBrowserStackConnection } from './browserstack-connection-verification.ts';

const SERVICE = 'BrowserStack';

/** The `connect browserstack` callbacks, loaded only when the CLI runs them. */
export function createBrowserStackConnection(
  host: ProviderPluginHost,
): Pick<PluginConnection, 'resolve' | 'verify'> {
  return {
    resolve: ({ flags, cwd }) => {
      rejectRefusedProviderProfileFields(flags, BROWSERSTACK_PROFILE_FIELDS);
      requireBrowserStackCredentials(host.env, `connect ${PROVIDER}`);
      const platform = requireConnectPlatform(flags, PROVIDER);
      const device = requireConnectFlag(flags.device, PROVIDER, '--device <name>');
      const providerOsVersion = requireConnectFlag(
        flags.providerOsVersion,
        PROVIDER,
        '--provider-os-version <version>',
      );
      const providerApp = connectAppReference(
        requireConnectFlag(
          flags.providerApp,
          PROVIDER,
          '--provider-app <bs://app-id-or-local-path>',
        ),
        cwd,
      );
      return {
        profile: {
          leaseProvider: PROVIDER,
          platform,
          device,
          providerOsVersion,
          providerApp,
          providerProject: flags.providerProject,
          providerBuild: flags.providerBuild,
          providerSessionName: flags.providerSessionName,
          ...readBrowserStackDeviceFeatureFields(flags),
        },
        // Verification reads these flags; it must see the canonical reference the profile saved,
        // not the spelling typed on the command line.
        extraFlags: { providerApp },
      };
    },
    verify: async ({ flags }) =>
      await verifyBrowserStackConnection(
        {
          ...requireBrowserStackCredentials(host.env, `connect ${PROVIDER}`),
          platform: requireResolvedProfilePlatform(flags.platform, SERVICE),
          deviceName: requireResolvedProfileValue(
            flags.device,
            'BrowserStack profile missed device.',
          ),
          osVersion: requireResolvedProfileValue(
            flags.providerOsVersion,
            'BrowserStack profile missed OS version.',
          ),
          app: requireResolvedProfileValue(flags.providerApp, 'BrowserStack profile missed app.'),
        },
        host.clientVersion,
      ),
  };
}

/** The hub fetches a public URL itself; a `bs://` id is canonicalized and anything else must be a local file. */
function connectAppReference(app: string, cwd: string): string {
  if (/^https?:\/\//i.test(app)) return app;
  return parseBrowserStackAppReference(app) ?? resolveLocalAppArtifact(app, cwd, SERVICE);
}
