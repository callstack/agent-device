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
import { revylTextFlag } from './session-allocation.ts';

const PROVIDER = 'revyl';
const SERVICE = 'Revyl';

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
      requireRevylCredentials(host.env, `connect ${PROVIDER}`);
      const platform = requireConnectPlatform(flags);
      const app = requireAppUrl(flags.providerApp, host);
      // Stored through the same canonicalizer allocation reads with, so the profile and the
      // `start_device` body cannot differ by surrounding whitespace.
      const deviceModel = revylTextFlag(flags.device);
      const osVersion = revylTextFlag(flags.providerOsVersion);
      return {
        profile: {
          leaseProvider: PROVIDER,
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
        requireRevylCredentials(host.env, `connect ${PROVIDER}`),
        host.clientVersion,
        requireResolvedProfilePlatform(flags.platform, SERVICE),
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

/**
 * A public https URL with no credentials, which is the shape Revyl's `app_url` takes. Revyl fetches
 * the build from its own network, so a URL that resolves inside the caller's — loopback, a private
 * range, or a `.local`/`.internal` name — can never be read there and is refused here rather than at
 * the first session start.
 */
function isPublicAppUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || url.username || url.password) return false;
  return isPublicHost(url.hostname);
}

/** Hostnames only the caller's own network can answer, which is where Revyl's fetcher never reaches. */
function isPublicHost(hostname: string): boolean {
  // `URL.hostname` keeps the brackets around an IPv6 literal.
  const host = hostname.replace(/^\[/, '').replace(/\]$/, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost')) return false;
  if (host.endsWith('.local') || host.endsWith('.internal')) return false;
  const address = host.includes(':') ? parseIpv6(host) : parseIpv4(host);
  if (address === undefined) return true;
  return !isNonRoutableAddress(address);
}

function parseIpv4(host: string): number[] | undefined {
  const parts = host.split('.');
  if (parts.length !== 4) return undefined;
  const bytes = parts.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : Number.NaN));
  return bytes.every((byte) => byte >= 0 && byte <= 255) ? bytes : undefined;
}

function parseIpv6(host: string): string | undefined {
  return /^[0-9a-f:]+$/.test(host) && host.includes(':') ? host : undefined;
}

function isNonRoutableAddress(address: number[] | string): boolean {
  if (typeof address === 'string') {
    const compressed = address.toLowerCase();
    return (
      compressed === '::' ||
      compressed === '::1' ||
      compressed.startsWith('fc') ||
      compressed.startsWith('fd') ||
      compressed.startsWith('fe80')
    );
  }
  const [a, b] = address as [number, number, number, number];
  // 0.0.0.0/8, 10/8, 100.64/10 (carrier NAT), 127/8, 169.254/16 (link-local), 172.16/12, 192.168/16.
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  return a === 192 && b === 168;
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
