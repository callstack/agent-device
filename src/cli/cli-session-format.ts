// Version 2 records the origin that issued the credential. Version 1 did not, and an older login
// could follow a redirect to another cloud and save that cloud's credential under its own URL.
export const CLI_SESSION_FORMAT_VERSION = 2;

export type CliSessionRecord = {
  version: typeof CLI_SESSION_FORMAT_VERSION;
  id: string;
  cloudBaseUrl: string;
  /** The origin of `cloudBaseUrl` that the login reached through same-origin requests only. */
  issuerOrigin: string;
  workspaceId?: string;
  accountId?: string;
  name?: string;
  refreshCredential: string;
  createdAt: string;
  expiresAt?: string;
};

/**
 * Parses the session file text. A record whose issuer the file does not establish answers
 * `unverified`: an older format version, or a record whose `issuerOrigin` is not its URL's origin.
 * Text that is not a record with a credential answers `null`. Text that is not JSON throws.
 */
export function parseCliSessionRecord(text: string): CliSessionRecord | 'unverified' | null {
  const parsed = JSON.parse(text) as Partial<CliSessionRecord> | null;
  if (typeof parsed !== 'object' || parsed === null || !hasText(parsed.refreshCredential)) {
    return null;
  }
  if (
    parsed.version !== CLI_SESSION_FORMAT_VERSION ||
    !hasText(parsed.id) ||
    !hasText(parsed.cloudBaseUrl) ||
    !hasText(parsed.createdAt) ||
    parsed.issuerOrigin !== readOrigin(parsed.cloudBaseUrl)
  ) {
    return 'unverified';
  }
  return parsed as CliSessionRecord;
}

function readOrigin(url: string): string | undefined {
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}

function hasText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
