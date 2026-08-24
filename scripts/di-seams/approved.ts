import type { ApprovedSeam } from './model.ts';

/**
 * Each entry is a decision about one (file, field, typeof-target) triple, not a name pattern
 * (PR #2006 review, #1976). Exempting every `typeof fetch` seam by spelling would silently pass
 * a new, genuinely test-only fetch seam anywhere in the tree while banning an equally legitimate
 * seam under any other name. Naming the site is what "approved" means here — add an entry only
 * for a call site actually reviewed, never to make a whole identifier exempt.
 *
 * check.ts fails as hard on a stale entry (one whose triple no longer matches anything in the
 * tree) as it does on an unapproved seam, so this list cannot silently drift out of sync with
 * the code it is meant to describe.
 */
export const APPROVED_SEAMS: readonly ApprovedSeam[] = [
  {
    file: 'src/cli/auth-session.ts',
    field: 'fetch',
    target: 'fetch',
    reason:
      "AuthIo.fetch injects the fetch global, which has no module boundary vi.mock can " +
      'intercept. auth-session.test.ts injects it directly for exact per-call assertions.',
  },
  {
    file: 'src/cli/auth-session.ts',
    field: 'fetchImpl',
    target: 'fetch',
    reason:
      'Same fetch-global seam as AuthIo.fetch above, threaded through the device-auth-poll ' +
      'and postJson helpers as fetchImpl.',
  },
  {
    file: 'src/cli/connection/cloud-profile.ts',
    field: 'fetchImpl',
    target: 'fetch',
    reason:
      'Same fetch-global seam, for the cloud connection-profile request. Exercised at the CLI ' +
      "layer by cloud-connect-profile.test.ts via vi.stubGlobal('fetch', ...), a layer where " +
      'this parameter is not reachable.',
  },
  {
    file: 'src/remote/daemon-proxy.ts',
    field: 'fetchImpl',
    target: 'fetch',
    reason: "Same fetch-global seam, for the remote daemon proxy's upstream request.",
  },
  {
    file: 'src/daemon/handlers/interaction-touch-response.ts',
    field: 'dispatchPath',
    target: 'MAESTRO_COORDINATE_FALLBACK_PATH',
    reason:
      'Not a DI seam at all: derives a literal union-member type from a constant for ' +
      'discriminated-union typing, not an injectable optional parameter. The seam pattern ' +
      'matches it only by syntax coincidence.',
  },
];
