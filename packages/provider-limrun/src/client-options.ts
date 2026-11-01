import type Limrun from '@limrun/api';
import { AppError } from '@agent-device/kernel/errors';

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

/** The organization client, or a typed refusal for an operation that needs the API key. */
export function requireLimrunOrgClient(
  limrun: Limrun | undefined,
  operation: string,
  hint = 'This daemon drives an existing Limrun instance with its own token. Set LIMRUN_API_KEY, or ask the instance owner to do this.',
): Limrun {
  if (limrun) return limrun;
  throw new AppError('UNSUPPORTED_OPERATION', `${operation} requires a Limrun API key.`, { hint });
}
