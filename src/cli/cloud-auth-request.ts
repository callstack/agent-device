import { AppError, type ReasonTable } from '@agent-device/kernel/errors';
import { readCloudJsonResponse } from './cloud-response.ts';

const HTTP_TIMEOUT_MS = 15_000;
const MAX_CLOUD_AUTH_REDIRECTS = 3;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
// Fetch turns a POST into a GET without a body on these. A 307 or 308 keeps the method and body.
const GET_REDIRECT_STATUSES = new Set([301, 302, 303]);

/** Every `details.reason` a cloud auth request publishes about a redirect it does not follow. */
const CLOUD_AUTH_REQUEST_REASONS = {
  // A cloud auth request was redirected to another origin. The request was not sent there, so no
  // credential or device code left the requested origin.
  crossOriginRedirect: { reason: 'cloud_auth_redirect_cross_origin', commands: ['connect'] },
  // A cloud auth request was redirected more than three times within its origin.
  redirectLimit: { reason: 'cloud_auth_redirect_limit', commands: ['connect'] },
  // A cloud auth request got a redirect with no readable Location, or with a Location that carries
  // a username or password. The request was not sent there.
  unsupportedRedirect: { reason: 'cloud_auth_redirect_unsupported', commands: ['connect'] },
} as const satisfies ReasonTable<'auth'>;

/**
 * Posts JSON to a cloud auth endpoint and reads the JSON answer. Every auth request carries a
 * credential or a device code, so a redirect is followed only to the origin of the original request,
 * at most three times, and never to a target with a username or password. A 307 or 308 keeps the
 * POST and its body. A 301, 302 or 303 continues the chain as a GET without the body. Any other
 * redirect fails with a typed reason before anything is sent again.
 */
export async function postCloudAuthJson<T>(options: {
  baseUrl: string;
  pathName: string;
  body: Record<string, unknown>;
  // di-seam-approved: injects the fetch global, which has no module boundary vi.mock can
  // intercept. The auth-session tests inject it for exact per-call assertions.
  fetchImpl?: typeof fetch;
  // Passed to the response reader, which calls it on a status it would otherwise reject generically.
  classifyRejectedBody?: (parsed: unknown) => AppError | undefined;
}): Promise<T> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const requestUrl = new URL(options.pathName, options.baseUrl);
  const body = JSON.stringify(options.body);
  // One timeout covers the whole redirect chain.
  const signal = AbortSignal.timeout(HTTP_TIMEOUT_MS);
  let url = requestUrl;
  let sendsBody = true;
  for (let redirects = 0; ; redirects += 1) {
    const response = await fetchImpl(
      url,
      sendsBody
        ? {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body,
            redirect: 'manual',
            signal,
          }
        : { method: 'GET', redirect: 'manual', signal },
    );
    if (!isRedirect(response)) {
      return await readCloudJsonResponse<T>(response, {
        invalidJsonMessage: `Cloud auth endpoint returned invalid JSON (${response.status}).`,
        rejectedMessage: 'Cloud auth endpoint rejected the request.',
        classifyRejectedBody: options.classifyRejectedBody,
      });
    }
    await response.body?.cancel().catch(() => undefined);
    url = readRedirectTarget(response, url, requestUrl, redirects);
    if (GET_REDIRECT_STATUSES.has(response.status)) sendsBody = false;
  }
}

function isRedirect(response: Response): boolean {
  return response.type === 'opaqueredirect' || REDIRECT_STATUSES.has(response.status);
}

function readRedirectTarget(
  response: Response,
  current: URL,
  requestUrl: URL,
  redirects: number,
): URL {
  const { status } = response;
  const location = response.headers.get('location');
  const target = location ? parseUrl(location, current) : undefined;
  if (!target) {
    throw redirectRefusal(
      'Cloud auth endpoint answered with a redirect that has no readable Location.',
      CLOUD_AUTH_REQUEST_REASONS.unsupportedRedirect.reason,
      status,
      requestUrl,
    );
  }
  // Fetch rejects such a URL with an error that quotes it, and the target can echo a credential.
  if (target.username || target.password) {
    throw redirectRefusal(
      'Cloud auth endpoint redirected the request to a URL with a username or password.',
      CLOUD_AUTH_REQUEST_REASONS.unsupportedRedirect.reason,
      status,
      requestUrl,
    );
  }
  if (target.origin !== requestUrl.origin) {
    throw redirectRefusal(
      'Cloud auth endpoint redirected the request to another origin.',
      CLOUD_AUTH_REQUEST_REASONS.crossOriginRedirect.reason,
      status,
      requestUrl,
    );
  }
  if (redirects >= MAX_CLOUD_AUTH_REDIRECTS) {
    throw redirectRefusal(
      'Cloud auth endpoint redirected the request too many times.',
      CLOUD_AUTH_REQUEST_REASONS.redirectLimit.reason,
      status,
      requestUrl,
    );
  }
  return target;
}

function parseUrl(location: string, base: URL): URL | undefined {
  try {
    return new URL(location, base);
  } catch {
    return undefined;
  }
}

function redirectRefusal(message: string, reason: string, status: number, requestUrl: URL) {
  return new AppError('COMMAND_FAILED', message, {
    reason,
    status,
    hint: `Check that AGENT_DEVICE_CLOUD_BASE_URL names the cloud API origin that answers auth requests (now ${requestUrl.origin}).`,
  });
}
