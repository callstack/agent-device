import { expect, test } from 'vitest';
import { DAEMON_HTTP_PUBLIC_NETWORK_ACCESS } from '@agent-device/contracts/daemon-http';
import { restrictRemoteHttpRequest } from './http-authorization.ts';
import type { DaemonRequest } from '../../core/daemon-request.ts';

const PUBLICATION_ID = '6f1c2a4e-0b7d-4c1e-9a55-3d2f8e7b6a10';

function restrict(request: Omit<DaemonRequest, 'token' | 'session'>) {
  return restrictRemoteHttpRequest(
    { token: 'test', session: 'owned', ...request },
    false,
    DAEMON_HTTP_PUBLIC_NETWORK_ACCESS,
  );
}

test('a public open records under the publication ID its client minted', () => {
  const result = restrict({
    command: 'open',
    positionals: [],
    flags: { saveScript: true },
    meta: { scriptPublicationId: PUBLICATION_ID },
  });

  expect(result.flags?.saveScript).toBe(true);
  expect(result.meta?.scriptPublicationId).toBe(PUBLICATION_ID);
});

test.each([
  { name: 'an open without a publication ID', command: 'open', flags: { saveScript: true } },
  {
    name: 'a malformed publication ID',
    command: 'open',
    flags: { saveScript: true },
    meta: { scriptPublicationId: '../x' },
  },
  {
    name: 'an open host path',
    command: 'open',
    flags: { saveScript: '/host/a.ad' },
    meta: { scriptPublicationId: PUBLICATION_ID },
  },
  {
    name: 'a close',
    command: 'close',
    flags: { saveScript: true },
    meta: { scriptPublicationId: PUBLICATION_ID },
  },
  {
    name: 'an input carrier',
    command: 'open',
    input: { saveScript: true },
    meta: { scriptPublicationId: PUBLICATION_ID },
  },
  { name: 'an active publication', command: 'session_save_script' },
])('public script output refuses $name', ({ name: _name, ...request }) => {
  expect(() => restrict({ positionals: [], ...request })).toThrowError(
    expect.objectContaining({
      code: 'INVALID_ARGS',
      details: expect.objectContaining({ reason: 'REMOTE_HOST_INPUT_DENIED' }),
    }),
  );
});
