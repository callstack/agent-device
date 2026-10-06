import type Limrun from '@limrun/api';
import { AppError } from '@agent-device/kernel/errors';

export const LIMRUN_CLIENT_HEADER = 'agent-device-cli';

export function buildLimrunClientOptions(options: { apiKey: string; clientVersion: string }): {
  apiKey: string;
  defaultHeaders: Record<string, string>;
} {
  return {
    apiKey: options.apiKey,
    defaultHeaders: {
      'x-agent-device-client': LIMRUN_CLIENT_HEADER,
      'x-agent-device-version': options.clientVersion,
    },
  };
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
