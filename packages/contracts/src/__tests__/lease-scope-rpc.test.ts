import { expect, test } from 'vitest';
import { buildDaemonRpcRequest } from '../lease-scope.ts';

function leaseRpcParams(
  flags: { session?: string },
  meta: { sessionExplicit?: boolean },
): Record<string, unknown> {
  return buildDaemonRpcRequest(
    {
      token: 'token',
      session: 'default',
      command: 'lease_allocate',
      positionals: [],
      flags,
      meta: { tenantId: 'acme', runId: 'run-a', leaseBackend: 'android-instance', ...meta },
    },
    { id: 'id', includeTokenParam: false },
  ).params as Record<string, unknown>;
}

test.each([
  ['a client that named none', {}, { sessionExplicit: false }, false],
  ['a client that named one in its meta', {}, { sessionExplicit: true }, true],
  [
    'a client that named one in its flags',
    { session: 'default' },
    { sessionExplicit: false },
    true,
  ],
  ['a caller that predates the fact', {}, {}, undefined],
])('the lease method carries what %s said about its session', (_label, flags, meta, expected) => {
  expect(leaseRpcParams(flags, meta).sessionExplicit).toBe(expected);
});
