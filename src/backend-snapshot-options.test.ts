import assert from 'node:assert/strict';
import { test } from 'vitest';
import { snapshotOptionsToFlags } from './backend-snapshot-options.ts';

test('snapshot options map every backend preference into command flags', () => {
  assert.deepEqual(
    snapshotOptionsToFlags({
      interactiveOnly: true,
      scope: 'app',
      depth: 7,
      raw: true,
      customActions: true,
      includeHiddenContentHints: true,
      preferredBackend: 'tree',
    }),
    {
      snapshotInteractiveOnly: true,
      snapshotScope: 'app',
      snapshotDepth: 7,
      snapshotRaw: true,
      snapshotCustomActions: true,
      snapshotIncludeHiddenContentHints: true,
      snapshotPreferredBackend: 'tree',
    },
  );
});
