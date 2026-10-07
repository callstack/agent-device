import fs from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type {
  DeviceLease,
  LeaseLifecycleContext,
  ProviderDeviceInstallOptions,
  ProviderDeviceInstallResult,
} from '@agent-device/contracts/device';
import {
  PROVIDER_DEVICE_ORIENTATIONS,
  type ProviderDeviceOrientation,
} from '@agent-device/contracts/remote';
import { AppError, errorMessage } from '@agent-device/kernel/errors';
import { agentDeviceRequestHeaders } from './request-headers.ts';

export type LeaseValue<T> = T | ((lease: DeviceLease) => T);

/** Best-effort release after a failure; a failed release rides along as `cleanupError`, never masks the primary. */
export async function releaseOnFailure(
  primaryError: unknown,
  release: () => Promise<unknown> | undefined,
): Promise<void> {
  try {
    await release();
  } catch (cleanupError) {
    if (primaryError instanceof AppError) {
      primaryError.details = { ...primaryError.details, cleanupError: errorMessage(cleanupError) };
    }
  }
}

export function resolveLeaseValue<T>(
  value: LeaseValue<T> | undefined,
  lease: DeviceLease,
): T | undefined {
  return typeof value === 'function' ? (value as (lease: DeviceLease) => T)(lease) : value;
}

export function basicAuthHeader(credentials: { username: string; accessKey: string }): string {
  return `Basic ${Buffer.from(`${credentials.username}:${credentials.accessKey}`).toString('base64')}`;
}

export function trimLeadingSlash(value: string): string {
  let firstNonSlash = 0;
  while (firstNonSlash < value.length && value.charCodeAt(firstNonSlash) === 47) {
    firstNonSlash += 1;
  }
  return firstNonSlash === 0 ? value : value.slice(firstNonSlash);
}

export function trimTrailingSlash(value: string): string {
  let lastNonSlash = value.length - 1;
  while (lastNonSlash >= 0 && value.charCodeAt(lastNonSlash) === 47) {
    lastNonSlash -= 1;
  }
  return lastNonSlash === value.length - 1 ? value : value.slice(0, lastNonSlash + 1);
}

/** Appends `route` to the base's path; a query on the base is kept rather than swallowing the route. */
export function appendUrlPath(base: string | URL, route: string): URL {
  const url = new URL(base);
  url.pathname = `${trimTrailingSlash(url.pathname)}/${route}`;
  return url;
}

export function withTrailingSlash(url: URL): URL {
  if (url.pathname.endsWith('/')) return url;
  const copy = new URL(url);
  copy.pathname = `${copy.pathname}/`;
  return copy;
}

type HubCredentials = { username: string; accessKey: string };

/**
 * A multipart form carrying the local app file under the hub's field name. Upload APIs take one
 * regular file, so anything else (an extracted `.app` directory, a missing path) is refused here,
 * before any request.
 */
export async function appFileUploadForm(
  appPath: string,
  fileField: string,
  hub: { provider: string; service: string },
): Promise<FormData> {
  const entry = await stat(appPath).catch(() => undefined);
  if (!entry?.isFile()) {
    throw new AppError(
      'INVALID_ARGS',
      `${hub.service} can only upload a regular app file: ${appPath}`,
      {
        provider: hub.provider,
        appPath,
        hint: 'Use an existing .ipa, .apk, or .aab file, or a .zip of the iOS simulator .app bundle.',
      },
    );
  }
  const form = new FormData();
  form.set(fileField, new Blob([await readFile(appPath)]), path.basename(appPath));
  return form;
}

/**
 * POSTs an app upload to a hosted hub and returns the hub's app reference. A non-2xx answer, a
 * body that is not JSON, or one without a reference is `COMMAND_FAILED` with the HTTP status.
 */
export async function postHubAppUpload(
  form: FormData,
  options: {
    service: string;
    endpoint: string | URL;
    clientVersion: string;
    auth: HubCredentials;
    readAppReference: (body: unknown) => string | undefined;
  },
  signal?: AbortSignal,
): Promise<string> {
  const response = await fetch(options.endpoint, {
    method: 'POST',
    headers: {
      ...agentDeviceRequestHeaders(options.clientVersion),
      Authorization: basicAuthHeader(options.auth),
    },
    body: form,
    signal,
  });
  const json = await readProviderJsonBody(response);
  const appReference = options.readAppReference(json)?.trim();
  if (!response.ok || !appReference) {
    throw new AppError('COMMAND_FAILED', `${options.service} app upload failed.`, {
      status: response.status,
      response: json,
    });
  }
  return appReference;
}

/** The `install` adapter of a hosted hub: upload the local build, then launch the hinted app. */
export function createHubUploadApp(
  upload: (appPath: string, signal?: AbortSignal) => Promise<string>,
): (params: {
  appPath: string;
  options?: ProviderDeviceInstallOptions;
  signal?: AbortSignal;
}) => Promise<ProviderDeviceInstallResult & { appReference: string }> {
  return async ({ appPath, options, signal }) => ({
    appReference: await upload(appPath, signal),
    bundleId: options?.appIdentifierHint,
    packageName: options?.packageNameHint,
    launchTarget: options?.appIdentifierHint ?? options?.packageNameHint,
  });
}

/**
 * Turns `--provider-app` into a reference the hub accepts: its own reference passes through in
 * canonical form when it fits the hub's grammar, public URLs pass through, and anything else must
 * be a local file to upload.
 */
export async function resolveHubAppReference(options: {
  service: string;
  app: string;
  cwd?: string;
  /** How the scheme reads in the error message, e.g. `a bs:// app id`. */
  referenceLabel: string;
  /**
   * The canonical spelling of the hub's own reference, or undefined when `app` is not one. Throws
   * when `app` uses the hub's scheme outside its grammar.
   */
  parseReference: (app: string) => string | undefined;
  uploadFile: (appPath: string, signal?: AbortSignal) => Promise<string>;
  signal?: AbortSignal;
}): Promise<string> {
  const { app } = options;
  const reference = options.parseReference(app);
  if (reference !== undefined) return reference;
  if (/^https?:\/\//i.test(app)) return app;
  const appPath = path.resolve(options.cwd ?? process.cwd(), app);
  if (!fs.existsSync(appPath)) {
    throw new AppError(
      'INVALID_ARGS',
      `${options.service} --provider-app must be ${options.referenceLabel}, URL, or existing local app path.`,
      { providerApp: app },
    );
  }
  return await options.uploadFile(appPath, options.signal);
}

const PROVIDER_API_TIMEOUT_MS = 15_000;

/** Service name and remediation hints a verification failure carries. */
type ProviderJsonFailureHints = {
  service: string;
  unauthorizedHint: string;
  networkHint: string;
};

/**
 * Fetches JSON from a hosted provider's API during connection verification. A 401/403 is
 * `UNAUTHORIZED` with a credential hint, any other non-2xx or a body that is not JSON is
 * `COMMAND_FAILED` with the status, and a transport failure is wrapped so its cause survives
 * without leaking the credentials.
 */
export async function fetchProviderVerificationJson(
  endpoint: string | URL,
  options: {
    clientVersion: string;
    /** Omitted for a public catalog endpoint. */
    auth?: { username: string; accessKey: string };
    hints: ProviderJsonFailureHints;
  },
): Promise<unknown> {
  const { service, unauthorizedHint, networkHint } = options.hints;
  const serviceHint = `Retry connect or check the ${service} service status.`;
  try {
    const response = await fetch(endpoint, {
      headers: {
        ...agentDeviceRequestHeaders(options.clientVersion),
        ...(options.auth ? { Authorization: basicAuthHeader(options.auth) } : {}),
      },
      signal: AbortSignal.timeout(PROVIDER_API_TIMEOUT_MS),
    });
    if (!response.ok) {
      const unauthorized = response.status === 401 || response.status === 403;
      throw new AppError(
        unauthorized ? 'UNAUTHORIZED' : 'COMMAND_FAILED',
        `${service} rejected connection verification.`,
        {
          status: response.status,
          hint: unauthorized ? unauthorizedHint : serviceHint,
        },
      );
    }
    const json = await readProviderJsonBody(response);
    if (json === undefined) {
      throw new AppError(
        'COMMAND_FAILED',
        `${service} connection verification answer was not JSON.`,
        { status: response.status, hint: serviceHint },
      );
    }
    return json;
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(
      'COMMAND_FAILED',
      `${service} connection verification failed.`,
      { hint: networkHint },
      error,
    );
  }
}

/**
 * Fetches a provider's session-details JSON with basic auth under a deadline. A transport failure,
 * a non-2xx answer, or a body that is not a JSON object is `COMMAND_FAILED`.
 */
export async function fetchProviderSessionDetails(
  endpoint: string | URL,
  options: {
    clientVersion: string;
    auth: { username: string; accessKey: string };
    service: string;
  },
): Promise<Record<string, unknown>> {
  let response: Response;
  let json: unknown;
  try {
    response = await fetch(endpoint, {
      headers: {
        ...agentDeviceRequestHeaders(options.clientVersion),
        Authorization: basicAuthHeader(options.auth),
      },
      signal: AbortSignal.timeout(PROVIDER_API_TIMEOUT_MS),
    });
    json = await readProviderJsonBody(response);
  } catch (error) {
    throw new AppError(
      'COMMAND_FAILED',
      `${options.service} session details lookup failed.`,
      { hint: `Check network access to the ${options.service} API, then retry.` },
      error,
    );
  }
  const details =
    json && typeof json === 'object' && !Array.isArray(json)
      ? (json as Record<string, unknown>)
      : undefined;
  if (!response.ok || !details) {
    throw new AppError('COMMAND_FAILED', `${options.service} session details lookup failed.`, {
      status: response.status,
      response: json,
    });
  }
  return details;
}

/** A provider response body parsed as JSON, or `undefined` when it is empty or not JSON (a gateway error page). */
async function readProviderJsonBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.length === 0) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** `1.0` and `1` name the same OS release on BrowserStack's catalog. */
export function sameOsVersion(left: string, right: string): boolean {
  const normalize = (value: string) => value.replace(/(?:\.0)+$/, '');
  return normalize(left) === normalize(right);
}

/** Validates a device-orientation flag against the shared enum before it reaches a hub that would ignore it. */
export function requireProviderDeviceOrientation(
  spec: { flag: string; capability: string },
  value: string,
): ProviderDeviceOrientation {
  const match = PROVIDER_DEVICE_ORIENTATIONS.find((orientation) => orientation === value);
  if (match) return match;
  throw new AppError('INVALID_ARGS', `Invalid ${spec.flag} value: ${value}.`, {
    hint: `Use ${PROVIDER_DEVICE_ORIENTATIONS.join('|')}.`,
    flag: spec.flag,
    capability: spec.capability,
  });
}

/** Lease-flag and credential readers every hosted-WebDriver provider shares. */
export function requireRequest(
  req: LeaseLifecycleContext | undefined,
  providerLabel: string,
): LeaseLifecycleContext {
  if (req) return req;
  throw new AppError(
    'INVALID_ARGS',
    `${providerLabel} lease allocation requires provider profile flags on the request.`,
  );
}

export function requireRequestPlatform(
  req: LeaseLifecycleContext,
  providerLabel: string,
): 'android' | 'ios' {
  const platform = req.flags?.platform;
  if (platform === 'android' || platform === 'ios') return platform;
  throw new AppError('INVALID_ARGS', `${providerLabel} requires --platform ios|android.`);
}

export function requireFlag(req: LeaseLifecycleContext, key: string, message: string): string {
  const value = readFlag(req, key);
  if (value) return value;
  throw new AppError('INVALID_ARGS', message);
}

export function readFlag(req: LeaseLifecycleContext, key: string): string | undefined {
  const value = req.flags?.[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** A whitespace-only credential is missing, not one the provider should reject later. */
export function requireEnv<Key extends string>(
  env: Readonly<Partial<Record<Key, string>>>,
  key: Key,
  providerLabel: string,
): string {
  const value = env[key];
  if (value?.trim()) return value;
  throw new AppError('INVALID_ARGS', `${providerLabel} requires ${key} in the environment.`);
}
