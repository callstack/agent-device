import assert from 'node:assert/strict';
import { test } from 'vitest';
import { normalizeError } from '@agent-device/kernel/errors';
import { readCloudJsonResponse } from '../cloud-response.ts';

const options = { invalidJsonMessage: 'Invalid JSON', rejectedMessage: 'Cloud request rejected' };

for (const status of [401, 403]) {
  test(`cloud response ${status} remains an authentication error`, async () => {
    await assert.rejects(
      readCloudJsonResponse(new Response('{"token":"secret"}', { status }), options),
      (error: unknown) => {
        const normalized = normalizeError(error);
        assert.equal(normalized.code, 'UNAUTHORIZED');
        assert.equal(normalized.details?.status, status);
        assert.doesNotMatch(JSON.stringify(normalized), /secret/);
        return true;
      },
    );
  });
}

for (const status of [404, 429, 503]) {
  test(`cloud response ${status} preserves status without requesting login`, async () => {
    await assert.rejects(
      readCloudJsonResponse(new Response('{"accessToken":"secret"}', { status }), options),
      (error: unknown) => {
        const normalized = normalizeError(error);
        assert.equal(normalized.code, 'COMMAND_FAILED');
        assert.equal(normalized.details?.status, status);
        assert.equal(normalized.retriable, status === 429 || status >= 500 ? true : undefined);
        assert.doesNotMatch(JSON.stringify(normalized), /secret|accessToken/);
        return true;
      },
    );
  });
}

test('cloud response keeps successful JSON and invalid JSON behavior', async () => {
  assert.deepEqual(await readCloudJsonResponse(new Response('{"ok":true}'), options), { ok: true });
  await assert.rejects(readCloudJsonResponse(new Response('{'), options), (error: unknown) => {
    assert.equal(normalizeError(error).code, 'COMMAND_FAILED');
    assert.equal(normalizeError(error).details?.status, 200);
    return true;
  });
});
