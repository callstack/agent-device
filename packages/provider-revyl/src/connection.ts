import type { CliFlags } from '@agent-device/contracts/command';
import type { ProviderPluginHost } from 'agent-device/plugins';
import {
  rejectRefusedProviderProfileFields,
  requireResolvedProfilePlatform,
} from '@agent-device/contracts/provider-profile-fields';
import type { ProviderConnectionVerification } from '@agent-device/contracts/remote';
import { AppError } from '@agent-device/kernel/errors';
import { REVYL_PROVIDER, REVYL_SERVICE, type RevylPlatform } from './device.ts';
import { requireRevylCredentials, type RevylCredentials } from './credentials.ts';
import { createRevylClient } from './revyl-client.ts';
import { REVYL_PROFILE_FIELDS } from './profile-fields.ts';
import { revylTextFlag } from './session-allocation.ts';

/** The connect half of the plugin, bound to one host's environment. */
export type RevylConnection = ReturnType<typeof createRevylConnection>;

/**
 * Builds the connect half of the plugin: what a Revyl profile carries, and what proves the credentials
 * before a device is rented. The verify call authenticates without starting anything, so a mistyped
 * key costs one request rather than a session.
 */
export function createRevylConnection(host: ProviderPluginHost) {
  return {
    resolve: ({ flags }: { flags: CliFlags; cwd: string }) => {
      rejectRefusedProviderProfileFields(flags, REVYL_PROFILE_FIELDS);
      requireRevylCredentials(host.env, `connect ${REVYL_PROVIDER}`);
      const platform = requireConnectPlatform(flags);
      const app = requireAppUrl(flags.providerApp, host);
      // Stored through the same canonicalizer allocation reads with, so the profile and the
      // `start_device` body cannot differ by surrounding whitespace.
      const deviceModel = revylTextFlag(flags.device);
      const osVersion = revylTextFlag(flags.providerOsVersion);
      return {
        profile: {
          leaseProvider: REVYL_PROVIDER,
          platform,
          ...(deviceModel === undefined ? {} : { device: deviceModel }),
          providerApp: app,
          ...(osVersion === undefined ? {} : { providerOsVersion: osVersion }),
        },
        extraFlags: { providerApp: app },
      };
    },
    verify: async ({ flags }: { flags: CliFlags }) => {
      // A hand-authored profile reaches verify without passing through `resolve`, so the fields Revyl
      // reads none of are refused here too rather than at the first allocation.
      rejectRefusedProviderProfileFields(flags, REVYL_PROFILE_FIELDS);
      const deviceModel = revylTextFlag(flags.device);
      const osVersion = revylTextFlag(flags.providerOsVersion);
      return await verifyRevylProfile(
        requireRevylCredentials(host.env, `connect ${REVYL_PROVIDER}`),
        host.clientVersion,
        requireResolvedProfilePlatform(flags.platform, REVYL_SERVICE),
        {
          appUrl: requireAppReference(flags.providerApp),
          ...(deviceModel === undefined ? {} : { deviceModel }),
          ...(osVersion === undefined ? {} : { osVersion }),
        },
      );
    },
  };
}

/**
 * Proves the credentials against the backend and reports the selected profile, both before a device is
 * rented. Revyl starts a device from the platform, an optional model and OS version, and an app URL, so
 * every one of those is what the verification reports back; nothing about them can be checked against
 * a catalog, because Revyl picks the device from its own pool at start time.
 */
export async function verifyRevylProfile(
  credentials: RevylCredentials,
  clientVersion: string,
  platform: RevylPlatform,
  profile: Readonly<{ appUrl: string; deviceModel?: string; osVersion?: string }>,
): Promise<ProviderConnectionVerification> {
  const client = createRevylClient({
    apiKey: credentials.apiKey,
    ...(credentials.apiUrl === undefined ? {} : { backendUrl: credentials.apiUrl }),
    clientVersion,
  });
  await client.verifyCredentials();
  if (!isRevylAppUrl(profile.appUrl)) {
    throw new AppError(
      'INVALID_ARGS',
      `${REVYL_SERVICE} installs the app from a URL, so --provider-app must be an https URL.`,
      {
        reason: 'invalid_provider_app',
        hint: `Pass the URL ${REVYL_SERVICE} can read the build from; a local path cannot.`,
      },
    );
  }
  return {
    provider: REVYL_PROVIDER,
    service: REVYL_SERVICE,
    verificationMessage: `Credentials verified; ${REVYL_SERVICE} picks the device when the session starts.`,
    device: {
      status: 'configured',
      ...(profile.deviceModel === undefined ? {} : { name: profile.deviceModel }),
      platform,
      ...(profile.osVersion === undefined ? {} : { osVersion: profile.osVersion }),
      message: `${REVYL_SERVICE} assigns a device of this platform when the session starts; a model or OS version it has no device for is reported then.`,
    },
    app: {
      status: 'configured',
      reference: profile.appUrl,
      message: `App URL configured; ${REVYL_SERVICE} fetches and installs it when the session starts.`,
    },
  };
}

/**
 * The shape Revyl's `app_url` takes: an https URL with no credentials. Revyl downloads the build from
 * its own network and reports what it cannot reach, so the URL's reachability is Revyl's to answer and
 * only its shape is checked here.
 */
function isRevylAppUrl(value: string | undefined): boolean {
  if (value === undefined) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return url.protocol === 'https:' && !url.username && !url.password;
}

/** Revyl rents a phone or a tablet, so only the two mobile platforms resolve. */
function requireConnectPlatform(flags: CliFlags): RevylPlatform {
  if (flags.platform === 'ios' || flags.platform === 'android') return flags.platform;
  throw new AppError('INVALID_ARGS', `connect ${REVYL_PROVIDER} requires --platform ios|android.`, {
    reason: 'unsupported_platform',
  });
}

function requireAppUrl(app: string | undefined, host: ProviderPluginHost): string {
  const value = app?.trim();
  if (!value) {
    throw host.createError(
      'INVALID_ARGS',
      `connect ${REVYL_PROVIDER} requires --provider-app <https-url> with the build to install.`,
    );
  }
  if (!isRevylAppUrl(value)) {
    throw host.createError(
      'INVALID_ARGS',
      `connect ${REVYL_PROVIDER} installs the app from an https URL; "${value}" is not one.`,
    );
  }
  return value;
}

/** Reads the app reference back out of the resolved profile verify is handed. */
function requireAppReference(app: string | undefined): string {
  const value = app?.trim();
  if (!value) {
    throw new AppError('COMMAND_FAILED', `${REVYL_SERVICE} profile missed its app URL.`, {
      hint: 'Reconnect with --provider-app <https-url>.',
    });
  }
  return value;
}
