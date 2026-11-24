import { AppError, type ReasonTable } from '@agent-device/kernel/errors';
import type { CliFlags } from '@agent-device/contracts/command';
import { sleep } from '@agent-device/host-kit/retry';
import type { CloudSessionBinding } from '@agent-device/remote/remote-connection-state';
import { parseCloudEndpoint } from '../cloud-origin.ts';
import {
  asCloudRecord,
  containsCloudCredential,
  cloudUrlContainsCredential,
  fetchCloudApi,
  isCloudText,
  isCloudTextArray,
  readCloudJsonResponse,
} from '../cloud-response.ts';
const CLOUD_SESSION_API_REASONS = {
  // The cloud did not finish allocating a session before the connect deadline.
  timeout: { reason: 'cloud_session_connect_timeout', commands: ['connect'] },
  // The account balance cannot cover the cost to start the session.
  insufficientBalance: { reason: 'insufficient_balance', commands: ['connect'] },
  // The cloud session uses an attachment transport this CLI cannot drive.
  transportUnsupported: { reason: 'cloud_transport_unsupported', commands: ['connect'] },
  // The cloud API returned an invalid session response.
  invalidSession: { reason: 'cloud_session_invalid', commands: ['connect'] },
} as const satisfies ReasonTable<'cloud sessions'>;

type CloudAccess = { cloudBaseUrl: string; accessToken: string };

export type CloudAttachment = {
  kind: 'agent-device-daemon';
  daemonBaseUrl: string;
  daemonAuthToken: string;
};

export type CreatedCloudSession = {
  binding: Omit<CloudSessionBinding, 'generation'>;
  attachment: CloudAttachment;
  viewerUrl?: string;
  fallbackFrom?: string[];
};

const SESSIONS_PATH = '/v1/sessions';
const MICROS_PER_USD = 1_000_000n;
const TOP_UP_URL_PATTERN = /^[!-~]{1,2048}$/;
const LIMIT_HINT = 'Raise the limit in the dashboard or wait for the next month.';
const LIMIT_REFUSAL_MESSAGES = {
  key_budget_exceeded: 'This API key reached its spending limit, so no session was started.',
  account_cap_exceeded: 'The account reached its spending cap, so no session was started.',
} as const;
const AMOUNT_PATTERN = /^\d{1,15}$/;
const BALANCE_PATTERN = /^-?\d{1,15}$/;
const CONNECT_TIMEOUT_MS = 240_000;
// Give the provider its two-minute allocation window and leave time to recover a lost response.
const CREATE_REQUEST_TIMEOUT_MS = 125_000;
const CREATE_RETRY_INTERVAL_MS = 2_000;
const RETRY_CREATION = Symbol('retry cloud session creation');
const CREATE_RESPONSE_MESSAGES = {
  invalidJsonMessage: 'Cloud session API returned invalid JSON.',
  rejectedMessage: 'Cloud session API could not create a session.',
};

export function readCloudSessionRequest(flags: CliFlags) {
  if (flags.platform !== 'ios' && flags.platform !== 'android') {
    throw new AppError('INVALID_ARGS', 'connect cloud requires --platform ios or android.');
  }
  const needs = flags.needs?.split(',').map((capability) => capability.trim());
  if (needs?.some((capability) => !capability)) {
    throw new AppError('INVALID_ARGS', '--needs requires a comma-separated list of capabilities.');
  }
  const device = flags.device?.trim();
  const os = flags.osVersion?.trim();
  if (flags.vendor !== undefined && !flags.vendor.trim()) {
    throw new AppError('INVALID_ARGS', '--vendor requires a catalog ID.');
  }
  return {
    platform: flags.platform,
    vendor: flags.vendor,
    accepts: ['agent-device-daemon'] as const,
    maxMinutes: flags.maxMinutes,
    ...(needs ? { needs } : {}),
    ...(device ? { device } : {}),
    ...(os ? { os: qualifyCloudOs(os, flags.platform) } : {}),
  };
}

// A bare major such as `26` becomes `iOS 26`; any other value reaches the server as given.
function qualifyCloudOs(os: string, platform: 'ios' | 'android'): string {
  return /^\d+$/.test(os) ? `${platform === 'ios' ? 'iOS' : 'Android'} ${os}` : os;
}

export type CloudSessionRequest = ReturnType<typeof readCloudSessionRequest>;

type CloudCreateAttempt = {
  key: string;
  observeId: (id: string) => void;
};

export async function createCloudSession(
  access: CloudAccess,
  request: CloudSessionRequest,
  attempt: CloudCreateAttempt,
): Promise<CreatedCloudSession> {
  const record = await postCloudSession(access, request, attempt);
  return parseCloudSession(record.body, record.id, access, request);
}

export async function lookupCloudSession(
  access: CloudAccess,
  key: string,
): Promise<{ id: string; active: boolean } | undefined> {
  const query = new URLSearchParams({ idempotencyKey: key });
  const response = await fetchCloudApi(new URL(`${SESSIONS_PATH}?${query}`, access.cloudBaseUrl), {
    method: 'GET',
    headers: { authorization: `Bearer ${access.accessToken}` },
    signal: AbortSignal.timeout(30_000),
  });
  if (response.status === 404) {
    const body = asCloudRecord(
      await response
        .clone()
        .json()
        .catch(() => undefined),
    );
    if (body?.error === 'not_found') {
      await response.body?.cancel();
      return undefined;
    }
  }
  const body = asCloudRecord(
    await readCloudJsonResponse(response, {
      invalidJsonMessage: 'Cloud session API returned invalid JSON.',
      rejectedMessage: 'Cloud session API could not look up the session.',
    }),
  );
  if (!body || !isSessionId(body.id) || containsCloudCredential(body.id, [access.accessToken])) {
    throw invalidSession();
  }
  switch (body.state) {
    case 'running':
    case 'allocating':
    case 'ending':
      return { id: body.id, active: true };
    case 'failed':
    case 'settled':
      return { id: body.id, active: false };
    default:
      throw invalidSession();
  }
}

type CreatedResponse = { kind: 'created'; id: string; body: Record<string, unknown> };

async function postCloudSession(
  access: CloudAccess,
  request: CloudSessionRequest,
  attempt: CloudCreateAttempt,
): Promise<CreatedResponse> {
  const url = new URL(SESSIONS_PATH, access.cloudBaseUrl);
  const headers = {
    authorization: `Bearer ${access.accessToken}`,
    'content-type': 'application/json',
    'Idempotency-Key': attempt.key,
  };
  const body = JSON.stringify(request);
  const deadline = Date.now() + CONNECT_TIMEOUT_MS;
  for (let remaining = CONNECT_TIMEOUT_MS; remaining > 0; remaining = deadline - Date.now()) {
    const value = await requestCreateResponse(
      url,
      {
        method: 'POST',
        redirect: 'error',
        headers,
        body,
        signal: AbortSignal.timeout(Math.min(remaining, CREATE_REQUEST_TIMEOUT_MS)),
      },
      request.needs,
      access.accessToken,
    );
    if (value !== RETRY_CREATION) {
      observeCloudAllocation(value, access.accessToken, attempt);
      if (value.kind === 'created') return value;
    }
    const wait = Math.min(CREATE_RETRY_INTERVAL_MS, deadline - Date.now());
    if (wait > 0) await sleep(wait);
  }
  throw new AppError('COMMAND_FAILED', 'Timed out waiting for the cloud session API.', {
    reason: CLOUD_SESSION_API_REASONS.timeout.reason,
  });
}

function observeCloudAllocation(
  value: CreateResponse,
  brokerToken: string,
  attempt: CloudCreateAttempt,
): void {
  const scoped = value.kind === 'created' ? readScopedToken(value.body.attach) : undefined;
  const credentials = scoped ? [brokerToken, scoped] : [brokerToken];
  if (containsCloudCredential(value.id, credentials)) throw invalidSession();
  attempt.observeId(value.id);
}

type CreateResponse = CreatedResponse | { kind: 'allocating'; id: string };

async function requestCreateResponse(
  url: URL,
  init: RequestInit,
  needs: string[] | undefined,
  brokerToken: string,
): Promise<CreateResponse | typeof RETRY_CREATION> {
  try {
    return await readCreateResponse(await fetch(url, init), needs, url.origin);
  } catch (error) {
    if (!(error instanceof AppError)) return RETRY_CREATION;
    if (containsCloudCredential([error.message, error.details], [brokerToken])) {
      throw invalidSession();
    }
    throw error;
  }
}

async function readCreateResponse(
  response: Response,
  needs: string[] | undefined,
  origin: string,
): Promise<CreateResponse | typeof RETRY_CREATION> {
  const { status } = response;
  if (status >= 500) {
    await response.body?.cancel();
    return RETRY_CREATION;
  }
  if (isCreateRejectionStatus(status)) return readCreateRefusal(response, status, needs, origin);
  const body = asCloudRecord(await readCloudJsonResponse(response, CREATE_RESPONSE_MESSAGES));
  if (!body || !isSessionId(body.id)) throw invalidSession();
  return { kind: 'created', id: body.id, body };
}

async function readCreateRefusal(
  response: Response,
  status: 400 | 402 | 409 | 422 | 429,
  needs: string[] | undefined,
  origin: string,
): Promise<CreateResponse | typeof RETRY_CREATION> {
  const body = asCloudRecord(await response.json().catch(() => undefined));
  if (status === 409 && body?.error === 'allocation_in_progress') {
    return isSessionId(body.id) ? { kind: 'allocating', id: body.id } : RETRY_CREATION;
  }
  throw parseCreateRejection(status, body, needs, origin);
}

function isCreateRejectionStatus(status: number): status is 400 | 402 | 409 | 422 | 429 {
  return [400, 402, 409, 422, 429].includes(status);
}

export function isDefinitiveCloudCreateRejection(error: unknown): boolean {
  if (!(error instanceof AppError)) return false;
  const { status, reason } = error.details ?? {};
  return (
    status === 400 ||
    status === 402 ||
    status === 422 ||
    status === 429 ||
    (status === 409 && reason === 'session_not_running')
  );
}

function isSessionId(id: unknown): id is string {
  return typeof id === 'string' && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(id);
}

function parseCreateRejection(
  status: 400 | 402 | 409 | 422 | 429,
  body: Record<string, unknown> | undefined,
  needs: string[] | undefined,
  origin: string,
): AppError {
  const reason = body?.error;
  if (status === 400) return requestRejection(body);
  if (status === 422) return eligibilityRejection(body, needs);
  if (status === 402)
    return accountLimitRejection(reason, status) ?? insufficientBalance(body, origin);
  if (status === 409 && reason === 'session_not_running') {
    return new AppError('COMMAND_FAILED', 'The cloud session is no longer running.', {
      status,
      reason,
    });
  }
  if (status === 429 && reason === 'concurrency_limit') {
    return new AppError(
      'COMMAND_FAILED',
      'The account already runs its maximum number of cloud sessions. Disconnect one, then try again.',
      { status, reason },
    );
  }
  return genericCreateRejection(status);
}

function genericCreateRejection(status: number, reason?: 'invalid_request'): AppError {
  return new AppError('COMMAND_FAILED', CREATE_RESPONSE_MESSAGES.rejectedMessage, {
    status,
    ...(reason ? { reason } : {}),
  });
}

function requestRejection(body: Record<string, unknown> | undefined): AppError {
  const status = 400;
  const reason = body?.error;
  if (reason !== 'invalid_request') return genericCreateRejection(status);
  const field = body?.field;
  if (field !== 'device' && field !== 'os') return genericCreateRejection(status, reason);
  return new AppError('INVALID_ARGS', `The cloud session API rejected --${field}.`, {
    status,
    reason,
    field,
  });
}

function eligibilityRejection(
  body: Record<string, unknown> | undefined,
  needs: string[] | undefined,
): AppError {
  const status = 422;
  const reason = body?.error;
  switch (reason) {
    case 'device_unavailable':
      return new AppError('COMMAND_FAILED', 'No cloud provider offers that device right now.', {
        status,
        reason,
      });
    case 'idempotency_key_reused':
      return new AppError(
        'COMMAND_FAILED',
        'This cloud request key was used with different options.',
        { status, reason },
      );
    case 'cloud_transport_unsupported':
      return new AppError(
        'COMMAND_FAILED',
        'No matching offering uses an attachment transport this CLI can drive.',
        {
          status,
          reason,
          hint: 'Check the offering setup instructions or select another vendor.',
        },
      );
    case 'no_vendor_matches': {
      const capabilities = needs?.length ? ` (${needs.join(', ')})` : '';
      return new AppError('COMMAND_FAILED', `No cloud vendor matches the request${capabilities}.`, {
        status,
        reason,
        needs,
      });
    }
    default:
      return accountLimitRejection(reason, status) ?? genericCreateRejection(status);
  }
}

function accountLimitRejection(reason: unknown, status: 402 | 422): AppError | undefined {
  if (reason !== 'key_budget_exceeded' && reason !== 'account_cap_exceeded') return;
  return new AppError('INVALID_ARGS', LIMIT_REFUSAL_MESSAGES[reason], {
    status,
    reason,
    hint: LIMIT_HINT,
  });
}

function insufficientBalance(body: Record<string, unknown> | undefined, origin: string): AppError {
  const requiredUsdMicros = readAmount(body?.requiredUsdMicros, AMOUNT_PATTERN);
  const availableUsdMicros = readAmount(body?.availableUsdMicros, BALANCE_PATTERN);
  const shortfallUsdMicros = readAmount(body?.shortfallUsdMicros, AMOUNT_PATTERN);
  const topUpUrl = readTopUpUrl(body?.topUpUrl, origin);
  const amounts =
    requiredUsdMicros && availableUsdMicros
      ? ` It needs at least ${formatUsdMicros(requiredUsdMicros)} and the balance is ${formatUsdMicros(availableUsdMicros)}${shortfallUsdMicros ? ` (short by ${formatUsdMicros(shortfallUsdMicros)})` : ''}.`
      : '';
  const topUp = shortfallUsdMicros
    ? `Top up the balance (needs ${formatUsdMicros(shortfallUsdMicros)} more).`
    : 'Top up the balance.';
  return new AppError(
    'INVALID_ARGS',
    `The cloud balance is too low to start a session.${amounts}`,
    {
      status: 402,
      reason: CLOUD_SESSION_API_REASONS.insufficientBalance.reason,
      hint: topUpUrl ? `${topUp}\nTop up at ${topUpUrl}` : topUp,
      ...(requiredUsdMicros ? { requiredUsdMicros } : {}),
      ...(availableUsdMicros ? { availableUsdMicros } : {}),
      ...(shortfallUsdMicros ? { shortfallUsdMicros } : {}),
      ...(topUpUrl ? { topUpUrl } : {}),
    },
  );
}

function readAmount(value: unknown, pattern: RegExp): string | undefined {
  return typeof value === 'string' && pattern.test(value) ? value : undefined;
}

// A billing link is shown to a person, so keep only a plain https (or loopback http) URL.
function readTopUpUrl(value: unknown, origin: string): string | undefined {
  if (typeof value !== 'string' || !TOP_UP_URL_PATTERN.test(value)) return undefined;
  const url = parseCloudEndpoint(value, 'https:', 'http:');
  if (
    url?.origin === origin &&
    url.pathname === '/app/billing' &&
    !url.search &&
    (!url.hash || url.hash === '#top-up')
  )
    return url.href;
  return undefined;
}

function formatUsdMicros(micros: string): string {
  const negative = micros.startsWith('-');
  const digits = BigInt(negative ? micros.slice(1) : micros);
  const whole = digits / MICROS_PER_USD;
  const fraction = (digits % MICROS_PER_USD).toString().padStart(6, '0').replace(/0+$/, '');
  return `${negative ? '-' : ''}$${whole}.${fraction.padEnd(2, '0')}`;
}

export async function deleteCloudSession(access: CloudAccess, id: string): Promise<void> {
  if (!isSessionId(id) || containsCloudCredential(id, [access.accessToken])) throw invalidSession();
  const response = await fetchCloudApi(new URL(`${SESSIONS_PATH}/${id}`, access.cloudBaseUrl), {
    method: 'DELETE',
    headers: { authorization: `Bearer ${access.accessToken}` },
    signal: AbortSignal.timeout(30_000),
  });
  if (response.status === 409 && (await cloudSessionIsTerminal(access, id))) {
    await response.body?.cancel();
    return;
  }
  if (!response.ok) {
    await readCloudJsonResponse(response, {
      invalidJsonMessage: 'Cloud session API returned invalid JSON.',
      rejectedMessage: 'Cloud session API could not end the session.',
    });
  }
}

async function cloudSessionIsTerminal(access: CloudAccess, id: string): Promise<boolean> {
  const response = await fetchCloudApi(new URL(`${SESSIONS_PATH}/${id}`, access.cloudBaseUrl), {
    method: 'GET',
    headers: { authorization: `Bearer ${access.accessToken}` },
    signal: AbortSignal.timeout(30_000),
  });
  const body = asCloudRecord(await response.json().catch(() => undefined));
  return response.ok && body?.id === id && (body.state === 'failed' || body.state === 'settled');
}

function parseCloudSession(
  record: Record<string, unknown>,
  id: string,
  access: CloudAccess,
  request: ReturnType<typeof readCloudSessionRequest>,
): CreatedCloudSession {
  const { vendor, transport, platform, deadlineAt, viewerUrl, fallbackFrom } = record;
  if (transport !== 'agent-device-daemon') {
    throw new AppError(
      'COMMAND_FAILED',
      'The cloud session uses an unsupported attachment transport.',
      {
        reason: CLOUD_SESSION_API_REASONS.transportUnsupported.reason,
      },
    );
  }
  const attachment = parseDaemonAttachment(asCloudRecord(record.attach));
  if (
    !attachment ||
    platform !== request.platform ||
    !isPublicCatalogId(vendor) ||
    (request.vendor && vendor !== request.vendor) ||
    typeof deadlineAt !== 'string' ||
    !Number.isFinite(Date.parse(deadlineAt)) ||
    (viewerUrl !== undefined && !isCredentialEndpoint(viewerUrl))
  ) {
    throw invalidSession();
  }
  const safeViewerUrl = readSafeCloudViewer(attachment, access.accessToken, {
    vendor,
    fallbackFrom,
    viewerUrl,
  });
  return {
    binding: {
      id,
      baseUrl: access.cloudBaseUrl,
      vendor,
      transport: attachment.kind,
      deadlineAt,
      viewerAvailable: safeViewerUrl !== undefined,
    },
    attachment,
    viewerUrl: safeViewerUrl,
    ...(isCloudTextArray(fallbackFrom) &&
    fallbackFrom.length &&
    fallbackFrom.every(isPublicCatalogId)
      ? { fallbackFrom }
      : {}),
  };
}

function readSafeCloudViewer(
  attachment: CloudAttachment,
  brokerToken: string,
  display: { vendor: string; fallbackFrom: unknown; viewerUrl?: string },
): string | undefined {
  const credentials = [brokerToken, attachment.daemonAuthToken];
  if (
    containsCloudCredential(attachment, [brokerToken]) ||
    cloudUrlContainsCredential(attachment.daemonBaseUrl, [brokerToken]) ||
    containsCloudCredential(
      { vendor: display.vendor, fallbackFrom: display.fallbackFrom },
      credentials,
    ) ||
    (display.viewerUrl && cloudUrlContainsCredential(display.viewerUrl, [brokerToken]))
  )
    throw invalidSession();
  return display.viewerUrl &&
    !cloudUrlContainsCredential(display.viewerUrl, [attachment.daemonAuthToken])
    ? display.viewerUrl
    : undefined;
}

function readScopedToken(value: unknown): string | undefined {
  const attachment = asCloudRecord(value);
  const token = attachment?.daemonAuthToken;
  return isCloudText(token) ? token : undefined;
}

function isPublicCatalogId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9_-]{0,127}$/i.test(value);
}

export function parseCloudAttachment(value: unknown): CloudAttachment | undefined {
  const entry = asCloudRecord(value);
  return entry?.kind === 'agent-device-daemon' ? parseDaemonAttachment(entry) : undefined;
}

function parseDaemonAttachment(entry: Record<string, unknown> | undefined) {
  const { daemonBaseUrl, daemonAuthToken } = entry ?? {};
  if (isCredentialEndpoint(daemonBaseUrl) && isCloudText(daemonAuthToken)) {
    return { kind: 'agent-device-daemon' as const, daemonBaseUrl, daemonAuthToken };
  }
  return undefined;
}

function invalidSession(): AppError {
  return new AppError('COMMAND_FAILED', 'Cloud session API returned an invalid session.', {
    reason: CLOUD_SESSION_API_REASONS.invalidSession.reason,
  });
}

function isCredentialEndpoint(value: unknown): value is string {
  return typeof value === 'string' && !!parseCloudEndpoint(value, 'https:', 'http:');
}
