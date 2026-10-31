import { AppError } from '@agent-device/kernel/errors';

export const REVYL_API_KEY_VARIABLE = 'REVYL_API_KEY';
export const REVYL_API_URL_VARIABLE = 'REVYL_API_URL';

export type RevylCredentials = Readonly<{
  apiKey: string;
  /** Overrides the Revyl backend origin; unset uses the public backend. */
  apiUrl: string | undefined;
}>;

/**
 * Reads the Revyl credentials from a host environment. `command` names the entry point in the
 * refusal, so the caller who missed the key is told what to set and where to get it.
 */
export function requireRevylCredentials(
  env: Readonly<Record<string, string | undefined>>,
  command: string,
): RevylCredentials {
  const apiKey = env[REVYL_API_KEY_VARIABLE]?.trim();
  if (apiKey) {
    return { apiKey, apiUrl: env[REVYL_API_URL_VARIABLE]?.trim() || undefined };
  }
  throw new AppError('INVALID_ARGS', `${command} requires a Revyl API key.`, {
    reason: 'missing_provider_credentials',
    hint: `Set ${REVYL_API_KEY_VARIABLE} to a Revyl API key. Revyl issues keys to its customers; a partner integration gets one through Revyl's partner program.`,
    variables: [REVYL_API_KEY_VARIABLE],
  });
}
