import type Limrun from '@limrun/api';
import { AppError } from '@agent-device/kernel/errors';

export const LIMRUN_CLIENT_ID = 'agent-device-cli';

/** Prefixes the SDK User-Agent so Limrun attributes API-key traffic, including instance creation, to agent-device. */
export function limrunUserAgent(clientVersion: string): string {
  return `${LIMRUN_CLIENT_ID}/${clientVersion}`;
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
