import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'vitest';
import { INTERNAL_COMMANDS } from '../../command-catalog.ts';
import { LeaseRegistry } from '../lease-registry.ts';
import { getDaemonRouteOwnerFiles, runRequestHandlerChain } from '../request-handler-chain.ts';
import type { DaemonRequest, DaemonResponse } from '../types.ts';
import { makeIosSession } from '../../__tests__/test-utils/index.ts';
import { makeSessionStore } from '../../__tests__/test-utils/store-factory.ts';

function makeRequest(command: string, positionals: string[] = []): DaemonRequest {
  return {
    command,
    token: 'test-token',
    session: 'chain-test',
    positionals,
    flags: {},
    meta: { requestId: `req-${command}` },
  };
}

function makeChainParams(req: DaemonRequest) {
  const sessionStore = makeSessionStore('agent-device-request-chain-');
  sessionStore.set('chain-test', makeIosSession('chain-test'));
  return {
    req,
    sessionName: 'chain-test',
    logPath: '/tmp/agent-device-request-chain.log',
    sessionStore,
    leaseRegistry: new LeaseRegistry(),
    invoke: async (): Promise<DaemonResponse> => ({ ok: true, data: {} }),
    contextFromFlags: () => ({ logPath: '/tmp/agent-device-request-chain.log' }),
  };
}

test('route owner files match the production module loaders', () => {
  const source = fs.readFileSync(new URL('../request-handler-chain.ts', import.meta.url), 'utf8');
  const definitions = [
    ...source.matchAll(
      /(\w+): defineDaemonRoute\(\{\s+ownerFile: '([^']+)',\s+load: \(\) => import\('([^']+)'\),/g,
    ),
  ];
  const ownerFiles = getDaemonRouteOwnerFiles();
  const genericModulePath = /import \* as genericRequestHandlerModule from '([^']+)'/.exec(
    source,
  )?.[1];
  const genericOwnerFile =
    /generic: defineDaemonRoute\(\{\s+ownerFile: '([^']+)',\s+load: async \(\) => genericRequestHandlerModule,/.exec(
      source,
    )?.[1];

  assert.equal(definitions.length + 1, Object.keys(ownerFiles).length);
  for (const [, route, ownerFile, modulePath] of definitions) {
    assert.ok(route && ownerFile && modulePath);
    assert.equal(ownerFile, `src/daemon/${modulePath.slice(2)}`);
    assert.equal(ownerFiles[route as keyof typeof ownerFiles], ownerFile);
  }
  assert.ok(genericModulePath && genericOwnerFile);
  assert.equal(genericOwnerFile, `src/daemon/${genericModulePath.slice(2)}`);
  assert.equal(ownerFiles.generic, genericOwnerFile);
});

test('request handler chain routes trace commands to the record-trace family', async () => {
  const response = await runRequestHandlerChain(makeChainParams(makeRequest('trace', ['start'])));

  assert.equal(response?.ok, true);
  assert.equal(response?.data?.trace, 'started');
});

test('request handler chain leaves generic commands for fallback dispatch', async () => {
  for (const command of ['back', 'gesture', 'home', 'screenshot', 'scroll', 'swipe']) {
    const response = await runRequestHandlerChain(makeChainParams(makeRequest(command)));

    assert.equal(response, null, `${command} should fall through to generic dispatch`);
  }
});

test('request handler chain routes lease commands to the lease family', async () => {
  const response = await runRequestHandlerChain({
    ...makeChainParams({
      ...makeRequest(INTERNAL_COMMANDS.leaseAllocate),
      flags: { tenant: 'tenant-a', runId: 'run-a' },
    }),
    sessionName: 'other-session',
  });

  assert.equal(response?.ok, true);
  assert.equal(typeof response?.data?.lease, 'object');
});

test('request handler chain routes session commands to the session family', async () => {
  const response = await runRequestHandlerChain(
    makeChainParams(makeRequest(INTERNAL_COMMANDS.runtime, ['show'])),
  );

  assert.equal(response?.ok, true);
  assert.equal(response?.data?.session, 'chain-test');
  assert.equal(response?.data?.configured, false);
});
