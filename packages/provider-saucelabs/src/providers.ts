import { AppError, type ReasonTable } from '@agent-device/kernel/errors';
import { requireEnv } from '@agent-device/provider-webdriver/plugin';
import { canonicalSchemeReference } from '@agent-device/provider-webdriver/providers';

export const SAUCE_LABS_PROVIDER = 'saucelabs';
export const SAUCE_LABS_SERVICE = 'Sauce Labs';

/** The environment variables the plugin reads; all three are part of the credential fingerprint. */
export const SAUCE_LABS_VARIABLES = {
  username: 'SAUCE_USERNAME',
  accessKey: 'SAUCE_ACCESS_KEY',
  region: 'SAUCE_REGION',
} as const;

/** Why `connect saucelabs`, a Sauce Labs session, or its artifact lookup refused. */
export const SAUCE_LABS_REASONS = {
  // `SAUCE_REGION` names a data center Sauce Labs does not run.
  regionUnknown: { reason: 'saucelabs_region_unknown', commands: ['open', 'artifacts'] },
  // `--provider-app` uses the `storage:` scheme outside the file-id or `filename=` grammar.
  appReferenceInvalid: { reason: 'saucelabs_app_reference_invalid', commands: ['open'] },
  // `--provider-app` is a URL that is not HTTPS.
  appUrlInsecure: { reason: 'saucelabs_app_url_insecure', commands: ['open'] },
  // The region's real-device catalog lists no device that matches `--device` and `--provider-os-version`.
  deviceNotFound: { reason: 'saucelabs_device_not_found' },
  // The region's app storage holds no upload with the `storage:` file id.
  appNotFound: { reason: 'saucelabs_app_not_found' },
  // The `storage:` upload is an app for the other platform.
  appPlatformMismatch: { reason: 'saucelabs_app_platform_mismatch' },
  // The `storage:` upload is not an Android or iOS app, such as a test bundle.
  appKindUnsupported: { reason: 'saucelabs_app_kind_unsupported' },
  // The `storage:` upload is an iOS simulator build, which a real device cannot install.
  appSimulatorBuild: { reason: 'saucelabs_app_simulator_build' },
  // `--provider-no-resign-app` was set for an Android session; only iOS apps are re-signed.
  noResignAppIosOnly: { reason: 'saucelabs_no_resign_app_ios_only', commands: ['open'] },
  // The region's real-device job API has no job with the provider session id.
  jobNotFound: { reason: 'saucelabs_job_not_found', commands: ['artifacts', 'close'] },
} as const satisfies ReasonTable<'connect'>;

/** The data centers that run the Sauce Labs Real Device Cloud. */
export const SAUCE_LABS_REGIONS = ['us-west-1', 'eu-central-1', 'us-east-4'] as const;
export type SauceLabsRegion = (typeof SAUCE_LABS_REGIONS)[number];
const DEFAULT_SAUCE_LABS_REGION: SauceLabsRegion = 'us-west-1';

/** `SAUCE_REGION`, else Sauce's default US West data center. */
export function readSauceLabsRegion(
  env: Readonly<Record<string, string | undefined>>,
): SauceLabsRegion {
  const value = env[SAUCE_LABS_VARIABLES.region]?.trim() ?? '';
  if (value.length === 0) return DEFAULT_SAUCE_LABS_REGION;
  const region = SAUCE_LABS_REGIONS.find((candidate) => candidate === value.toLowerCase());
  if (region) return region;
  throw new AppError('INVALID_ARGS', `Sauce Labs has no data center named ${value}.`, {
    reason: SAUCE_LABS_REASONS.regionUnknown.reason,
    region: value,
    hint: `Set ${SAUCE_LABS_VARIABLES.region} to ${SAUCE_LABS_REGIONS.join(', ')}, or unset it for ${DEFAULT_SAUCE_LABS_REGION}.`,
  });
}

/** The W3C Appium hub of one data center; credentials travel as basic auth, never in capabilities. */
export function sauceLabsWebDriverEndpoint(region: SauceLabsRegion): string {
  return `https://ondemand.${region}.saucelabs.com/wd/hub/`;
}

/** The REST API of one data center: device catalog, app storage, and real-device jobs. */
export function sauceLabsApiEndpoint(region: SauceLabsRegion): string {
  return `https://api.${region}.saucelabs.com/`;
}

export function sauceLabsDashboardUrl(region: SauceLabsRegion, jobId: string): string {
  const host =
    region === DEFAULT_SAUCE_LABS_REGION ? 'app.saucelabs.com' : `app.${region}.saucelabs.com`;
  return `https://${host}/tests/${encodeURIComponent(jobId)}`;
}

export type SauceLabsCredentials = { username: string; accessKey: string };

/** The Sauce Labs credentials in `env`; `consumer` names the command a missing one fails. */
export function requireSauceLabsCredentials(
  env: Readonly<Record<string, string | undefined>>,
  consumer: string,
): SauceLabsCredentials {
  return {
    username: requireEnv(env, SAUCE_LABS_VARIABLES.username, consumer),
    accessKey: requireEnv(env, SAUCE_LABS_VARIABLES.accessKey, consumer),
  };
}

const SAUCE_LABS_APP_SCHEME = 'storage:';
const SAUCE_LABS_FILENAME_PREFIX = 'filename=';
const SAUCE_LABS_FILE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A Sauce Labs app storage reference: one upload by its file id, or the newest upload of a file name. */
export type SauceLabsAppReference =
  | { kind: 'file-id'; reference: string; fileId: string }
  | { kind: 'filename'; reference: string; filename: string };

/**
 * Reads `app` as a `storage:` reference in its canonical lower-case scheme, or undefined when it
 * does not use the scheme. A file id outside the UUID grammar, or a file name that is empty or holds
 * a path separator, would pass every local check and fail only at session creation, so it is refused.
 */
export function parseSauceLabsAppReference(app: string): SauceLabsAppReference | undefined {
  const reference = canonicalSchemeReference(app, SAUCE_LABS_APP_SCHEME);
  if (reference === undefined) return undefined;
  const value = reference.slice(SAUCE_LABS_APP_SCHEME.length);
  if (value.startsWith(SAUCE_LABS_FILENAME_PREFIX)) {
    const filename = value.slice(SAUCE_LABS_FILENAME_PREFIX.length);
    if (filename.trim().length > 0 && !/[/\\]/.test(filename)) {
      return { kind: 'filename', reference, filename };
    }
  } else if (SAUCE_LABS_FILE_ID.test(value)) {
    return { kind: 'file-id', reference, fileId: value };
  }
  throw new AppError(
    'INVALID_ARGS',
    `Sauce Labs --provider-app ${app} is not a storage:<file-id> or storage:filename=<name> reference.`,
    {
      reason: SAUCE_LABS_REASONS.appReferenceInvalid.reason,
      providerApp: app,
      hint: 'Pass storage:<file-id>, storage:filename=<name>, an https URL, or a local app path.',
    },
  );
}

/** Sauce Labs fetches an app URL itself; only HTTPS keeps the build out of plain text. */
export function isSauceLabsAppUrl(app: string): boolean {
  if (/^https:\/\//i.test(app)) return true;
  if (!/^http:\/\//i.test(app)) return false;
  throw new AppError('INVALID_ARGS', `Sauce Labs --provider-app ${app} is not an https URL.`, {
    reason: SAUCE_LABS_REASONS.appUrlInsecure.reason,
    providerApp: app,
    hint: 'Serve the app over https, or pass a storage: reference or a local app path.',
  });
}
