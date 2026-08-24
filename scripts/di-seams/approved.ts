import type { ApprovedSeam } from './model.ts';

/**
 * Each entry is a decision about one exact declaration — (file, line, field, typeof-target) —
 * not a name pattern and not a "this pattern may recur in this file" blanket (PR #2006 review,
 * #1976). Exempting every `typeof fetch` seam by spelling would silently pass a new, genuinely
 * test-only fetch seam anywhere in the tree while banning an equally legitimate seam under any
 * other name; exempting by (file, field, target) alone would silently pass a SECOND, unreviewed
 * occurrence of an already-approved field/target pair anywhere in the same file. Naming the exact
 * site is what "approved" means here — add an entry only for a call site actually reviewed, never
 * to make a whole identifier or field/target pair exempt.
 *
 * check.ts fails as hard on a stale entry (one whose quadruple no longer matches anything — the
 * site moved, even by an unrelated edit shifting its line number, was renamed, or was removed) as
 * it does on an unapproved seam, so this list cannot silently drift out of sync with the tree.
 */
export const APPROVED_SEAMS: readonly ApprovedSeam[] = [
  {
    file: 'src/cli/auth-session.ts',
    line: 74,
    field: 'fetch',
    target: 'fetch',
    reason:
      'AuthIo.fetch injects the fetch global, which has no module boundary vi.mock can ' +
      'intercept. auth-session.test.ts injects it directly for exact per-call assertions.',
  },
  {
    file: 'src/cli/auth-session.ts',
    line: 411,
    field: 'fetchImpl',
    target: 'fetch',
    reason:
      'Same fetch-global seam as AuthIo.fetch above, threaded through the device-auth-poll ' +
      'helper as fetchImpl.',
  },
  {
    file: 'src/cli/auth-session.ts',
    line: 449,
    field: 'fetchImpl',
    target: 'fetch',
    reason:
      'Same fetch-global seam as AuthIo.fetch above, threaded through the postJson helper as ' +
      'fetchImpl.',
  },
  {
    file: 'src/cli/connection/cloud-profile.ts',
    line: 24,
    field: 'fetchImpl',
    target: 'fetch',
    reason:
      'Same fetch-global seam, on the connect-flow helper that resolves the cloud connection ' +
      "profile. Exercised at the CLI layer by cloud-connect-profile.test.ts via vi.stubGlobal('fetch', " +
      '...), a layer where this parameter is not reachable.',
  },
  {
    file: 'src/cli/connection/cloud-profile.ts',
    line: 67,
    field: 'fetchImpl',
    target: 'fetch',
    reason: 'Same fetch-global seam as above, on the fetchConnectionProfile request itself.',
  },
  {
    file: 'src/remote/daemon-proxy.ts',
    line: 22,
    field: 'fetchImpl',
    target: 'fetch',
    reason: "Same fetch-global seam, for the remote daemon proxy's upstream request.",
  },
  {
    file: 'src/daemon/handlers/interaction-touch-response.ts',
    line: 60,
    field: 'dispatchPath',
    target: 'MAESTRO_COORDINATE_FALLBACK_PATH',
    reason:
      'Not a DI seam at all: derives a literal union-member type from a constant for ' +
      'discriminated-union typing, not an injectable optional parameter. The seam pattern ' +
      'matches it only by syntax coincidence.',
  },
];
