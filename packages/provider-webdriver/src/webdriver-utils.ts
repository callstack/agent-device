import fs from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type {
  DeviceLease,
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

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

type HubCredentials = { username: string; accessKey: string };

/** A multipart form carrying the local app file under the hub's field name. */
export async function appFileUploadForm(appPath: string, fileField: string): Promise<FormData> {
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
  const appReference = options.readAppReference(json);
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
 * Turns `--provider-app` into a reference the hub accepts: its own reference scheme passes
 * through, a public URL passes through unless the hub only takes its own references (then
 * `uploadUrl` has the hub fetch it), and anything else must be a local file to upload.
 */
export async function resolveHubAppReference(options: {
  service: string;
  app: string;
  cwd?: string;
  referenceScheme: string;
  /** How the scheme reads in the error message, e.g. `a bs:// app id`. */
  referenceLabel: string;
  /** Validates a canonical reference; by default any non-empty id after the scheme is accepted. */
  isReference?: (reference: string) => boolean;
  uploadFile: (appPath: string, signal?: AbortSignal) => Promise<string>;
  uploadUrl?: (url: string, signal?: AbortSignal) => Promise<string>;
  signal?: AbortSignal;
}): Promise<string> {
  const { app } = options;
  const reference = canonicalHubAppReference(app, options.referenceScheme);
  if (reference !== undefined) {
    const isReference =
      options.isReference ?? ((value: string) => value.length > options.referenceScheme.length);
    if (isReference(reference)) return reference;
    throw new AppError(
      'INVALID_ARGS',
      `${options.service} --provider-app ${app} is not ${options.referenceLabel}.`,
      { providerApp: app },
    );
  }
  if (/^https?:\/\//i.test(app)) {
    return options.uploadUrl ? await options.uploadUrl(app, options.signal) : app;
  }
  const appPath = path.resolve(options.cwd ?? process.cwd(), app);
  const stat = fs.statSync(appPath, { throwIfNoEntry: false });
  if (!stat) {
    throw new AppError(
      'INVALID_ARGS',
      `${options.service} --provider-app must be ${options.referenceLabel}, URL, or existing local app path.`,
      { providerApp: app },
    );
  }
  if (!stat.isFile()) {
    throw new AppError(
      'INVALID_ARGS',
      `${options.service} --provider-app must be an app file, not a directory: ${appPath}`,
      {
        providerApp: app,
        hint: 'Zip an iOS simulator .app bundle and pass the .zip, or pass the .ipa, .apk, or .aab.',
      },
    );
  }
  return await options.uploadFile(appPath, options.signal);
}

/** URI schemes are case-insensitive, so `LT://id` is the hub reference `lt://id`. */
function canonicalHubAppReference(app: string, scheme: string): string | undefined {
  if (app.slice(0, scheme.length).toLowerCase() !== scheme) return undefined;
  return `${scheme}${app.slice(scheme.length)}`;
}

const PROVIDER_API_TIMEOUT_MS = 15_000;

/** The provider rejected or could not answer a verification call; typed so callers never sniff text. */
export type ProviderJsonFailureHints = {
  service: string;
  unauthorizedHint: string;
  /** For any other non-2xx answer, or a 2xx answer that is not JSON. */
  serviceHint: string;
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
    auth?: { username: string; accessKey: string };
    hints: ProviderJsonFailureHints;
  },
): Promise<unknown> {
  const { service, unauthorizedHint, serviceHint, networkHint } = options.hints;
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
  const details = asRecord(json);
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

/** `1.0` and `1` name the same OS release on BrowserStack's catalog; TestMu's hub matches spellings exactly. */
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
