import type { CliFlags } from '@agent-device/contracts/command';
import type { ProviderPluginHost } from 'agent-device/plugins';
import {
  rejectRefusedProviderProfileFields,
  requireResolvedProfilePlatform,
} from '@agent-device/contracts/provider-profile-fields';
import type { ProviderConnectionVerification } from '@agent-device/contracts/remote';
import { AppError } from '@agent-device/kernel/errors';
import type { RevylPlatform } from './device.ts';
import { requireRevylCredentials, type RevylCredentials } from './credentials.ts';
import { createRevylClient } from './revyl-client.ts';
import { REVYL_PROFILE_FIELDS } from './profile-fields.ts';

const PROVIDER = 'revyl';
const SERVICE = 'Revyl';

/**
 * The connect half of the plugin: what a Revyl profile carries, and what proves the credentials
 * before a device is rented. The verify call authenticates without starting anything, so a mistyped
 * key costs one request rather than a session.
 */
export function createRevylConnection(host: ProviderPluginHost) {
  return {
    resolve: ({ flags }: { flags: CliFlags; cwd: string }) => {
      rejectRefusedProviderProfileFields(flags, REVYL_PROFILE_FIELDS);
      requireRevylCredentials(host.env, `connect ${PROVIDER}`);
      const platform = requireConnectPlatform(flags);
      const app = requireAppUrl(flags.providerApp, host);
      return {
        profile: {
          leaseProvider: PROVIDER,
          platform,
          ...(flags.device === undefined ? {} : { device: flags.device }),
          providerApp: app,
          ...(flags.providerOsVersion === undefined
            ? {}
            : { providerOsVersion: flags.providerOsVersion }),
        },
        extraFlags: { providerApp: app },
      };
    },
    verify: async ({ flags }: { flags: CliFlags }) =>
      await verifyRevylProfile(
        requireRevylCredentials(host.env, `connect ${PROVIDER}`),
        host.clientVersion,
        requireResolvedProfilePlatform(flags.platform, SERVICE),
        {
          appUrl: requireAppReference(flags.providerApp),
          ...(flags.device === undefined ? {} : { deviceModel: flags.device }),
          ...(flags.providerOsVersion === undefined ? {} : { osVersion: flags.providerOsVersion }),
        },
      ),
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
  if (!isPublicAppUrl(profile.appUrl)) {
    throw new AppError(
      'INVALID_ARGS',
      'Revyl installs the app from a URL, so --provider-app must be a public https URL.',
      {
        reason: 'invalid_provider_app',
        hint: 'Publish the build where Revyl can read it and pass that URL; a local path cannot be.',
      },
    );
  }
  return {
    provider: PROVIDER,
    service: SERVICE,
    verificationMessage: 'Credentials verified; Revyl picks the device when the session starts.',
    device: {
      status: 'configured',
      ...(profile.deviceModel === undefined ? {} : { name: profile.deviceModel }),
      platform,
      ...(profile.osVersion === undefined ? {} : { osVersion: profile.osVersion }),
      message:
        'Revyl assigns a device of this platform when the session starts; a model or OS version it has no device for is reported then.',
    },
    app: {
      status: 'configured',
      reference: profile.appUrl,
      message: 'Public app URL configured; Revyl fetches and installs it when the session starts.',
    },
  };
}

/** A public https URL with no credentials, which is the shape Revyl's `app_url` takes. */
function isPublicAppUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password;
  } catch {
    return false;
  }
}

/** Revyl rents a phone or a tablet, so only the two mobile platforms resolve. */
function requireConnectPlatform(flags: CliFlags): RevylPlatform {
  if (flags.platform === 'ios' || flags.platform === 'android') return flags.platform;
  throw new AppError('INVALID_ARGS', `connect ${PROVIDER} requires --platform ios|android.`, {
    reason: 'unsupported_platform',
  });
}

function requireAppUrl(app: string | undefined, host: ProviderPluginHost): string {
  const value = app?.trim();
  if (!value) {
    throw host.createError(
      'INVALID_ARGS',
      `connect ${PROVIDER} requires --provider-app <https-url> with the build to install.`,
    );
  }
  if (!isPublicAppUrl(value)) {
    throw host.createError(
      'INVALID_ARGS',
      `connect ${PROVIDER} installs the app from a public https URL; "${value}" is not one.`,
    );
  }
  return value;
}

/** Reads the app reference back out of the resolved profile verify is handed. */
function requireAppReference(app: string | undefined): string {
  const value = app?.trim();
  if (!value) {
    throw new AppError('COMMAND_FAILED', `${SERVICE} profile missed its app URL.`, {
      hint: 'Reconnect with --provider-app <https-url>.',
    });
  }
  return value;
}
