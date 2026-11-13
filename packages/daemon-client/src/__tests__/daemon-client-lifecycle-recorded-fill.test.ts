import assert from 'node:assert/strict';
import { test } from 'vitest';
import { attachSessionAddressHints } from '../daemon-client-lifecycle.ts';

test('remote fill recording errors give a recovery path the remote client supports', () => {
  const response = {
    ok: false as const,
    error: {
      code: 'INVALID_ARGS',
      message:
        'fill --record-as requires an armed script recording. Start a fresh session with open --save-script, then retry the fill.',
      details: { reason: 'fill_record_as_requires_armed_recording' },
    },
  };
  const settings = { remoteBaseUrl: 'https://device.example' } as never;

  const remote = attachSessionAddressHints(response, {} as never, settings);
  assert.equal(remote.ok, false);
  if (remote.ok) return;
  assert.equal(remote.error.message, response.error.message);
  assert.equal(remote.error.details?.reason, 'fill_record_as_requires_armed_recording');

  const local = attachSessionAddressHints(response, {} as never, {} as never);
  assert.equal(local, response);
});
