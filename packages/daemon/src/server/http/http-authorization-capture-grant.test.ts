import { expect, test } from 'vitest';
import { DAEMON_HTTP_PUBLIC_NETWORK_ACCESS } from '@agent-device/contracts/daemon-http';
import { restrictRemoteHttpRequest } from './http-authorization.ts';
import type { DaemonRequest } from '../../core/daemon-request.ts';

const GRANT_ID = '6f1c2a4e-0b7d-4c1e-9a55-3d2f8e7b6a10';

function restrict(request: Omit<DaemonRequest, 'token' | 'session'>) {
  return restrictRemoteHttpRequest(
    { token: 'test', session: 'owned', ...request },
    false,
    DAEMON_HTTP_PUBLIC_NETWORK_ACCESS,
  );
}

test('a public record start keeps the capture grant ID its client minted', () => {
  const result = restrict({
    command: 'record',
    positionals: ['start'],
    meta: { captureGrantId: GRANT_ID },
  });
  expect(result.meta?.captureGrantId).toBe(GRANT_ID);
});

test.each([
  {
    name: 'a record stop',
    request: { command: 'record', positionals: ['stop'], meta: { captureGrantId: GRANT_ID } },
  },
  {
    name: 'a trace stop',
    request: { command: 'trace', positionals: ['stop'], meta: { captureGrantId: GRANT_ID } },
  },
  {
    name: 'a trace start (record-only scope)',
    request: { command: 'trace', positionals: ['start'], meta: { captureGrantId: GRANT_ID } },
  },
  {
    name: 'a perf start (record-only scope)',
    request: { command: 'perf', positionals: ['start'], meta: { captureGrantId: GRANT_ID } },
  },
  {
    name: 'a malformed grant ID on a record start',
    request: { command: 'record', positionals: ['start'], meta: { captureGrantId: '../x' } },
  },
  {
    name: 'a grant ID on an unrelated command',
    request: { command: 'snapshot', positionals: [], meta: { captureGrantId: GRANT_ID } },
  },
  {
    name: 'a grant ID on a batch step container',
    request: {
      command: 'batch',
      positionals: [],
      flags: { batchSteps: [{ command: 'snapshot', positionals: [] }] },
      meta: { captureGrantId: GRANT_ID },
    },
  },
])('public capture input drops the grant ID for $name', ({ request }) => {
  const result = restrict(request);
  expect(result.meta?.captureGrantId).toBeUndefined();
});
