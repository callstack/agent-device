import { AppError, type ReasonTable } from '@agent-device/kernel/errors';
import { readCloudJsonResponse } from './cloud-response.ts';

const HTTP_TIMEOUT_MS = 15_000;

const CLOUD_AUTH_REQUEST_REASONS = {
  // A cloud auth request got a redirect it does not follow: to another origin, past the third hop,
  // or to a missing Location or one with a username or password. Nothing was sent to the target.
  redirectRefused: { reason: 'cloud_auth_redirect_refused', commands: ['connect'] },
} as const satisfies ReasonTable<'auth'>;

/**
 * Posts JSON to a cloud auth endpoint and reads the JSON answer. Every auth request carries a
 * credential or a device code, so a redirect is followed only to the origin of the original request,
 * at most three times, and never to a target with a username or password. A 307 or 308 keeps the
 * POST and its body. A 301, 302 or 303 continues the chain as a GET without the body.
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
  const response = await fetchCloudOnOneOrigin(
    new URL(options.pathName, options.baseUrl),
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(options.body),
    },
    options.fetchImpl,
  );
  return await readCloudJsonResponse<T>(response, {
    invalidJsonMessage: `Cloud auth endpoint returned invalid JSON (${response.status}).`,
    rejectedMessage: 'Cloud auth endpoint rejected the request.',
    classifyRejectedBody: options.classifyRejectedBody,
  });
}

/**
 * Sends one credential-bearing cloud request and returns the final answer. The URL must be https,
 * or plain http to loopback. A redirect is followed only to the same origin, at most three times,
 * and never to a target with a username or password. A 301, 302 or 303 turns a POST into a GET
 * without its body; a GET keeps its headers on the same origin.
 */
export async function fetchCloudOnOneOrigin(
  requestUrl: URL,
  request: RequestInit,
  // di-seam-approved: the same fetch-global seam as postCloudAuthJson's fetchImpl.
  fetchImpl?: typeof fetch,
): Promise<Response> {
  const { fetchWithCredential, isRedirectStatus } =
    await import('@agent-device/host-kit/direct-http');
  const response = await fetchWithCredential(
    requestUrl,
    // One timeout covers the whole redirect chain.
    { ...request, signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) },
    { subject: 'Cloud base URL', send: fetchImpl },
  );
  if (!isRedirectStatus(response.status)) return response;
  await response.body?.cancel().catch(() => undefined);
  throw redirectRefused(response, requestUrl);
}

/** Why a redirect the send did not follow ends the request. */
function redirectRefused(response: Response, requestUrl: URL): AppError {
  const location = response.headers.get('location');
  const target = location === null ? null : URL.parse(location, requestUrl);
  return new AppError(
    'COMMAND_FAILED',
    `Cloud auth endpoint answered with ${describeRefusedRedirect(target, requestUrl)}.`,
    {
      reason: CLOUD_AUTH_REQUEST_REASONS.redirectRefused.reason,
      status: response.status,
      hint: `Cloud auth requests stay on ${requestUrl.origin}. Check that it is the cloud API origin.`,
    },
  );
}

function describeRefusedRedirect(target: URL | null, requestUrl: URL): string {
  if (!target) return 'a redirect that has no readable Location';
  // Fetch rejects such a URL with an error that quotes it, and the target can echo a credential.
  if (target.username || target.password) return 'a redirect to a URL with a username or password';
  if (target.origin !== requestUrl.origin) return 'a redirect to another origin';
  return 'more than three redirects';
}
