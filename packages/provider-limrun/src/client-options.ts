import Limrun from '@limrun/api';
import {
  AppError,
  errorMessage,
  isRequestCanceledError,
  type AppErrorCode,
  type ReasonTable,
} from '@agent-device/kernel/errors';
import type { LimrunDeleteResult } from './lease-ownership.ts';

export const LIMRUN_CLIENT_ID = 'agent-device-cli';

/** Prefixes the SDK User-Agent so Limrun attributes API-key traffic, including instance creation, to agent-device. */
export function limrunUserAgent(clientVersion: string): string {
  return `${LIMRUN_CLIENT_ID}/${clientVersion}`;
}

/**
 * Asks the SDK for one attempt at a request whose failure this runtime cannot tell apart from Limrun having
 * done the work: the SDK retries a lost answer by POSTing again, and a repeated instance create rents a
 * second instance. The SDK defaults to two retries, so a request that must not repeat carries this.
 *
 * The option is the SDK's request-scoped `maxRetries` (`RequestOptions`, @limrun/api 0.64.1), which every
 * resource method takes as its second argument. `session-allocation.test.ts` pins that this is what the
 * create honours: it drives the real SDK against a local server that drops the answer and asserts one POST.
 */
export const LIMRUN_SINGLE_ATTEMPT = Object.freeze({ maxRetries: 0 });

/**
 * Silences the SDK's own logging on every client this plugin builds.
 *
 * The SDK writes a failed request's response body, and the request details around it, to the console
 * before it throws — at `warn` by default, and at whatever `LIMRUN_LOG` names. Those bodies are the
 * peer's text and this plugin authenticates with an account key or an instance token, so a plain-text
 * error body can carry one of them unlabelled and no error handling downstream can take it back out.
 * `off` for the organization client and `none` for an instance client are the two SDKs' own values for
 * "log nothing"; the request's typed status and this plugin's own diagnostics still answer for a
 * failure.
 */
export const LIMRUN_ORG_CLIENT_LOGGING = Object.freeze({ logLevel: 'off' });

/** See {@link LIMRUN_ORG_CLIENT_LOGGING}. An instance client spells the same setting `none`. */
export const LIMRUN_INSTANCE_CLIENT_LOGGING = Object.freeze({ logLevel: 'none' }) as Readonly<{
  logLevel: 'none';
}>;

/** Verifies an attached instance without letting it reconnect, and logs nothing. */
export const LIMRUN_INSTANCE_PROBE_OPTIONS = Object.freeze({
  ...LIMRUN_INSTANCE_CLIENT_LOGGING,
  maxReconnectAttempts: 0,
});

/**
 * Ends one instance, answering with no failure once Limrun has it gone and with a failure string and its error
 * otherwise. Like the create, the delete is asked for in one attempt: a lost answer is ambiguous, and this
 * runtime's retries happen at its own budgets, not the SDK's. A 404 is Limrun answering that the instance is
 * already gone, which is exactly what the delete was asked to achieve, so it confirms rather than refuses.
 */
export async function deleteLimrunInstance(
  limrun: Limrun,
  platform: 'ios' | 'android',
  instanceId: string,
): Promise<LimrunDeleteResult> {
  try {
    if (platform === 'ios') {
      await limrun.iosInstances.delete(instanceId, LIMRUN_SINGLE_ATTEMPT);
    } else {
      await limrun.androidInstances.delete(instanceId, LIMRUN_SINGLE_ATTEMPT);
    }
    return { failure: undefined, cause: undefined };
  } catch (error) {
    // A 404 is Limrun answering that the instance is already gone, however it came about.
    if (readHttpStatus(error) === 404) return { failure: undefined, cause: undefined };
    // The failure string is written to the release record a caller reads back, and the SDK's own text is
    // the response body, which can carry the account key. The status answers for it instead.
    const normalized = limrunOrgApiError(error);
    return { failure: errorMessage(normalized), cause: normalized };
  }
}

/**
 * Whether a failure answers that the account API has nothing for what was asked — an instance that is
 * already gone. Callers that act on that outcome read this instead of the SDK's own error class, since
 * every account-API failure this plugin raises is normalized to a typed `AppError`.
 */
export function isLimrunApiNotFound(error: unknown): boolean {
  if (error instanceof AppError && error.details?.reason === 'limrun_api_not_found') return true;
  return readHttpStatus(error) === 404;
}

/** The HTTP status of an SDK failure, for a route that can answer for one particular refusal. */
function readHttpStatus(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const status = (error as { status?: unknown }).status;
  return typeof status === 'number' ? status : undefined;
}

/** The organization client, or a typed refusal for an operation that needs the API key. */
export function requireLimrunOrgClient(
  limrun: Limrun | undefined,
  operation: string,
  hint = 'This daemon drives an existing Limrun instance with its own token. Set LIMRUN_API_KEY, or ask the instance owner to do this.',
): Limrun {
  if (limrun) return limrun;
  throw new AppError('UNSUPPORTED_OPERATION', `${operation} requires a Limrun API key.`, { hint });
}

/**
 * Answers for one organization-API failure with this runtime's own words.
 *
 * The SDK builds an error's message from the response body — the body's `message` field, or the whole
 * body serialized — and that text is what a lease create, an asset list, or a delete returns to the
 * daemon, which records it and answers the caller with it. A body is Limrun's own text: it can name a
 * value this process authenticates with, and nothing downstream can pick a secret back out of a message
 * once it has been logged. So the account API's failures are re-raised as an `AppError` that keeps the
 * two things a caller acts on, the status and what kind of refusal it was, and adds nothing else.
 */
export async function fromLimrunOrgApi<T>(request: Promise<T>): Promise<T> {
  try {
    return await request;
  } catch (error) {
    throw limrunOrgApiError(error);
  }
}

/**
 * Every `details.reason` a failure of the organization API publishes. The account API's own text is not
 * published with it: the SDK builds its message from the response body, which can name the account key.
 */
const LIMRUN_ORG_API_REASONS = {
  // The account key was refused or lacks access to what was asked for.
  unauthorized: { reason: 'limrun_api_unauthorized' },
  // The account API has nothing under the identifier the request named.
  notFound: { reason: 'limrun_api_not_found' },
  // The account API is taking this key's requests too fast to answer them.
  rateLimited: { reason: 'limrun_api_rate_limited' },
  // The account API refused the request for a reason with no separate recovery.
  rejected: { reason: 'limrun_api_failed' },
} as const satisfies ReasonTable<'limrun'>;

const LIMRUN_ORG_HTTP_ERRORS = new Map<number, { code: AppErrorCode; reason: string }>([
  [401, { code: 'UNAUTHORIZED', reason: LIMRUN_ORG_API_REASONS.unauthorized.reason }],
  [403, { code: 'UNAUTHORIZED', reason: LIMRUN_ORG_API_REASONS.unauthorized.reason }],
  [404, { code: 'DEVICE_NOT_FOUND', reason: LIMRUN_ORG_API_REASONS.notFound.reason }],
  [429, { code: 'COMMAND_FAILED', reason: LIMRUN_ORG_API_REASONS.rateLimited.reason }],
]);

function limrunOrgApiError(error: unknown): unknown {
  const status = readHttpStatus(error);
  if (status === undefined) {
    if (
      (Limrun.APIUserAbortError && error instanceof Limrun.APIUserAbortError) ||
      (error instanceof Error && error.name === 'AbortError') ||
      isRequestCanceledError(error)
    )
      return error;
    return new AppError('COMMAND_FAILED', 'Limrun organization request failed.', {
      reason: LIMRUN_ORG_API_REASONS.rejected.reason,
    });
  }
  const classified = LIMRUN_ORG_HTTP_ERRORS.get(status);
  return new AppError(
    classified?.code ?? 'COMMAND_FAILED',
    `Limrun rejected the request (${status}).`,
    {
      status,
      reason: classified?.reason ?? LIMRUN_ORG_API_REASONS.rejected.reason,
    },
  );
}
