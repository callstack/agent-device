import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'vitest';
import { INTERNAL_COMMANDS } from '../../command-catalog.ts';
import { LeaseRegistry } from '../lease-registry.ts';
import { runRequestHandlerChain } from '../request-handler-chain.ts';
import { getDaemonRouteOwnerFiles } from '../route-owner-files.ts';
import type { DaemonRequest, DaemonResponse } from '../types.ts';
import {
  LINUX_DEVICE,
  makeIosSession,
  makeSession,
  makeSnapshotState,
} from '../../__tests__/test-utils/index.ts';
import { makeSessionStore } from '../../__tests__/test-utils/store-factory.ts';
import { dispatchSwipeViaRuntime } from '../handlers/interaction-gesture.ts';
import {
  createLocalLinuxToolProvider,
  withLinuxToolProvider,
} from '../../platforms/linux/tool-provider.ts';

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
    ...source.matchAll(/(\w+): defineDaemonRoute\(\{\s+load: \(\) => import\('([^']+)'\),/g),
  ];
  const ownerFiles = getDaemonRouteOwnerFiles();
  const genericModulePath = /import \* as genericRequestHandlerModule from '([^']+)'/.exec(
    source,
  )?.[1];
  const genericRouteMatches =
    /generic: defineDaemonRoute\(\{\s+load: async \(\) => genericRequestHandlerModule,/.test(
      source,
    );

  assert.equal(definitions.length + 1, Object.keys(ownerFiles).length);
  for (const [, route, modulePath] of definitions) {
    assert.ok(route && modulePath);
    assert.equal(ownerFiles[route as keyof typeof ownerFiles], `src/daemon/${modulePath.slice(2)}`);
  }
  assert.ok(genericModulePath && genericRouteMatches);
  assert.equal(ownerFiles.generic, `src/daemon/${genericModulePath.slice(2)}`);

  assert.ok(
    !/ownerFile/.test(source),
    'owner-file paths are tooling-only: keep them in route-owner-files.ts, not the production chain module',
  );
});

test('request handler chain routes trace commands to the record-trace family', async () => {
  const response = await runRequestHandlerChain(makeChainParams(makeRequest('trace', ['start'])));

  assert.equal(response?.ok, true);
  assert.equal(response?.data?.trace, 'started');
});

test('request handler chain leaves generic commands for fallback dispatch', async () => {
  for (const command of ['back', 'home', 'screenshot', 'scroll']) {
    const response = await runRequestHandlerChain(makeChainParams(makeRequest(command)));

    assert.equal(response, null, `${command} should fall through to generic dispatch`);
  }
});

test('request handler chain routes gesture through the interaction runtime', async () => {
  const response = await runRequestHandlerChain(makeChainParams(makeRequest('gesture')));

  assert.equal(response?.ok, false);
  if (response?.ok !== false) throw new Error('Expected invalid gesture response');
  assert.equal(response.error.code, 'INVALID_ARGS');
});

test('request handler chain routes swipe through the interaction runtime', async () => {
  const response = await runRequestHandlerChain(makeChainParams(makeRequest('swipe')));

  assert.equal(response?.ok, false);
  if (response?.ok !== false) throw new Error('Expected invalid swipe response');
  assert.equal(response.error.code, 'INVALID_ARGS');
});

test('swipe rejects repetition inputs that can monopolize the request', async () => {
  const cases = [
    {
      input: { count: 201 },
      message: 'Expected count to be at most 200.',
    },
    {
      input: { pauseMs: 10_001 },
      message: 'Expected pauseMs to be at most 10000.',
    },
    {
      input: { count: 7, pauseMs: 10_000 },
      message: 'Swipe series must fit within 60000ms.',
    },
  ];

  for (const { input, message } of cases) {
    const req = {
      ...makeRequest('swipe'),
      input: {
        from: { x: 10, y: 20 },
        to: { x: 110, y: 20 },
        ...input,
      },
    };
    const response = await runRequestHandlerChain(makeChainParams(req));

    assert.equal(response?.ok, false);
    if (response?.ok !== false) throw new Error('Expected invalid swipe response');
    assert.equal(response.error.code, 'INVALID_ARGS');
    assert.equal(response.error.message, message);
  }
});

test('duration-less public coordinate swipe retains Linux drag behavior', async () => {
  const sessionStore = makeSessionStore('agent-device-linux-swipe-');
  sessionStore.set('linux-swipe', makeSession('linux-swipe', { device: LINUX_DEVICE }));
  const drags: number[][] = [];
  const provider = createLocalLinuxToolProvider({
    input: {
      click: async () => {},
      doubleClick: async () => {},
      longPress: async () => {},
      drag: async (...values) => {
        drags.push(values);
      },
      scroll: async () => {},
      typeText: async () => {},
      key: async () => {},
    },
  });

  const response = await withLinuxToolProvider(
    provider,
    async () =>
      await dispatchSwipeViaRuntime({
        req: {
          ...makeRequest('swipe'),
          session: 'linux-swipe',
          input: { from: { x: 10, y: 20 }, to: { x: 110, y: 20 } },
        },
        sessionName: 'linux-swipe',
        sessionStore,
        contextFromFlags: () => ({}),
        captureSnapshotForSession: async () =>
          makeSnapshotState([
            {
              index: 0,
              rect: { x: 0, y: 0, width: 200, height: 200 },
              visibleToUser: true,
            },
          ]),
      }),
  );

  assert.equal(response.ok, true);
  if (!response.ok) return;
  assert.ok(response.data);
  assert.equal(response.data.kind, 'fling');
  assert.equal(response.data.durationMs, 100);
  assert.deepEqual(drags, [[10, 20, 110, 20, 100]]);
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
