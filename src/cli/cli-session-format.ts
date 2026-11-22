// Version 2 marks a session saved by a login whose every request stayed on the origin of
// `cloudBaseUrl`. A version 1 login could follow a redirect to another cloud and save that cloud's
// credential under its own URL, so a version 1 record does not establish its issuer.
export const CLI_SESSION_FORMAT_VERSION = 2;

export type CliSessionRecord = {
  version: typeof CLI_SESSION_FORMAT_VERSION;
  id: string;
  cloudBaseUrl: string;
  workspaceId?: string;
  accountId?: string;
  name?: string;
  refreshCredential: string;
  createdAt: string;
  expiresAt?: string;
};

/**
 * Parses the session file text. A record with a credential from another format version answers
 * `unverified`. Text that is not a complete record answers `null`. Text that is not JSON throws.
 */
export function parseCliSessionRecord(text: string): CliSessionRecord | 'unverified' | null {
  const parsed = JSON.parse(text) as Partial<CliSessionRecord> | null;
  if (typeof parsed !== 'object' || parsed === null || !hasText(parsed.refreshCredential)) {
    return null;
  }
  if (parsed.version !== CLI_SESSION_FORMAT_VERSION) return 'unverified';
  if (!hasText(parsed.id) || !hasText(parsed.cloudBaseUrl) || !hasText(parsed.createdAt)) {
    return null;
  }
  return parsed as CliSessionRecord;
}

function hasText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
