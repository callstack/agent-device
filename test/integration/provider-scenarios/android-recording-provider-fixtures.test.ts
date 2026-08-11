import assert from 'node:assert/strict';
import { test } from 'vitest';
import { createAndroidRecordingProvider } from './android-recording-provider-fixtures.ts';

test('Android recording provider fixtures reject unmodeled executable commands', async () => {
  const provider = createAndroidRecordingProvider({ calls: [] });

  await assert.rejects(
    provider.exec(['shell', 'echo unmodeled-provider-command']),
    /Unhandled Android recording provider command: shell echo unmodeled-provider-command/,
  );
});
