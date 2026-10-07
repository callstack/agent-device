import {
  rejectRefusedProviderProfileFields,
  requireResolvedProfilePlatform,
  requireResolvedProfileValue,
} from '@agent-device/contracts/provider-profile-fields';
import {
  BROWSERSTACK_PROFILE_FIELDS,
  parseBrowserStackAppReference,
  requireBrowserStackCredentials,
} from './browserstack.ts';
import { readBrowserStackDeviceFeatureFields } from './browserstack-device-features.ts';
import { verifyBrowserStackConnection } from './connection-verification.ts';
import type {
  CloudWebDriverConnection,
  CloudWebDriverConnectionContext,
  CloudWebDriverConnectProfileResolution,
  CloudWebDriverProviderHost,
} from './provider-plugin.ts';
import { CLOUD_WEBDRIVER_PROVIDERS } from './providers.ts';
import {
  requireConnectFlag,
  requireConnectPlatform,
  resolveLocalAppArtifact,
} from './webdriver-utils.ts';

const PROVIDER = CLOUD_WEBDRIVER_PROVIDERS.browserStack;
const SERVICE = 'BrowserStack';
const CONSUMER = `connect ${PROVIDER}`;

/** The `connect browserstack` callbacks, loaded only when the CLI runs them. */
export function createBrowserStackConnection(host: CloudWebDriverProviderHost): {
  resolve(context: CloudWebDriverConnectionContext): CloudWebDriverConnectProfileResolution;
} & CloudWebDriverConnection {
  return {
    resolve: ({ flags, cwd }): CloudWebDriverConnectProfileResolution => {
      rejectRefusedProviderProfileFields(flags, BROWSERSTACK_PROFILE_FIELDS);
      requireBrowserStackCredentials(host.env, CONSUMER);
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
          ...requireBrowserStackCredentials(host.env, CONSUMER),
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
