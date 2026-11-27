import { assertSecureCredentialTransport } from '@agent-device/contracts/credential-transport';
import { AppError, type ReasonTable } from '@agent-device/kernel/errors';

// Whether the upstream token may go to the configured daemon. Loaded with the first upstream
// exchange, never at module scope.

const UPSTREAM_ADMISSION_REASONS = {
  // The proxy's `upstreamBaseUrl` carries a username or password. The upstream credential is
  // `upstreamToken` alone, and a request cannot be built from such a URL.
  userinfo: { reason: 'proxy_upstream_userinfo' },
} as const satisfies ReasonTable<'proxy'>;

/** Refuses every upstream base URL the proxy must not send to. The refusal never quotes it. */
export function assertAdmittedUpstream(upstreamBaseUrl: string): void {
  // Checked first, so that a username or password gets this refusal whatever the scheme.
  const upstream = URL.parse(upstreamBaseUrl);
  if (!upstream?.username && !upstream?.password) {
    assertSecureCredentialTransport(upstreamBaseUrl, 'Proxy upstreamBaseUrl');
    return;
  }
  throw new AppError(
    'INVALID_ARGS',
    'Proxy upstreamBaseUrl must not carry a username or password.',
    {
      reason: UPSTREAM_ADMISSION_REASONS.userinfo.reason,
      hint: 'Pass the daemon credential as upstreamToken, and remove it from the URL.',
    },
  );
}
