import { describe, expect, test } from 'vitest';
import { isReplayBackendId, unsupportedReplayBackendMessage } from '../format.ts';

// The #3377 backend registry is keyed by this grammar's vocabulary: these two are what the
// client's `parseReplayInput`, the daemon's plan-side rejection, and the registry all share, so
// the accepted-value set and the rejection wording are pinned here rather than at any consumer.
describe('replay backend vocabulary', () => {
  test('accepts the registered backend value', () => {
    expect(isReplayBackendId('maestro')).toBe(true);
  });

  test.each([undefined, '', 'ad', 'unknown', 'MAESTRO'])(
    'rejects %s — only the grammar registers a backend',
    (value) => {
      expect(isReplayBackendId(value)).toBe(false);
    },
  );

  test('formats the unsupported-backend diagnostic once for every rejecting caller', () => {
    expect(unsupportedReplayBackendMessage('unknown')).toBe(
      'Unsupported replay backend "unknown".',
    );
  });
});
