import type { DaemonResponse } from '@agent-device/kernel/contracts';
import { daemonPlatformServicesFixture } from '../__tests__/support/platform-services-fixture.ts';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'vitest';
import { INTERNAL_COMMANDS } from '@agent-device/command-registry/catalog';
import { LeaseRegistry } from '../resources/lease-registry.ts';
import { runRequestHandlerChain } from './request-handler-chain.ts';
import { getDaemonRouteOwnerFiles } from '@agent-device/command-registry/owner-files';
import type { DaemonRequest } from '../index.ts';
import {
  bindTestCommandHost,
  eagerClosureOf,
  LINUX_DEVICE,
  createTestHostEnvironment,
} from '@agent-device/test-kit';
import { buildGesturePlan, singlePointerPlanEndpoints } from '@agent-device/contracts/gesture-plan';
import { makeIosSession, makeSession } from '../__tests__/support/session-factories.ts';
import { makeSessionStore } from '../__tests__/support/store-factory.ts';
import { handleInteractionCommands } from '../execution/interaction/index.ts';
import { createRequestRuntimeBindings } from '../core/request-runtime-binding.ts';
import { createRequestDispatchLedger } from '../core/request-dispatch-ledger.ts';
import {
  unavailableBindDevice,
  unavailableBindExactDevice,
  unavailableDeviceRuntimeGateway,
  unavailableInspectFacts,
} from '../__tests__/support/unavailable-device-runtime-gateway.ts';
import {
  gestureDeviceRuntimeGateway,
  gestureInspectFacts,
  gestureRuntimeSpies,
} from '../__tests__/support/test-device-runtime-gateway.ts';
import { createAudioProbeAdmissionLedger } from '@agent-device/capture-kit/audio-probe-admission-ledger';
import { createPerfCaptureAdmissionLedger } from '@agent-device/capture-kit/perf-capture-admission-ledger';
import { createScreenRecordingAdmissionLedger } from '@agent-device/capture-kit/screen-recording-admission-ledger';
import { createTouchCommandSurface } from '../__tests__/support/touch-command-surface-fake.ts';

bindTestCommandHost();
const testCreateCommandSurface = createTouchCommandSurface();

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
  sessionStore.publish('chain-test', makeIosSession('chain-test'));
  return {
    host: createTestHostEnvironment(),
    createCommandSurface: testCreateCommandSurface,
    req,
    sessionName: 'chain-test',
    logPath: '/tmp/agent-device-request-chain.log',
    sessionStore,
    leaseRegistry: new LeaseRegistry(),
    platformServices: daemonPlatformServicesFixture(),
    invoke: async (): Promise<DaemonResponse> => ({ ok: true, data: {} }),
    providerScope: {},
    bindDevice: unavailableBindDevice,
    inspectFacts: unavailableInspectFacts,
    bindExactDevice: unavailableBindExactDevice,
    reconcileOrphanedDeviceClaim: async () => ({
      status: 'retained' as const,
      reason: 'test-no-recovery',
    }),
    screenRecordingAdmissionLedger: createScreenRecordingAdmissionLedger(),
    audioProbeAdmissionLedger: createAudioProbeAdmissionLedger(),
    perfCaptureAdmissionLedger: createPerfCaptureAdmissionLedger(),
    requestScope: {
      signal: new AbortController().signal,
      diagnostics: { emit: () => {} },
      progress: { report: () => {} },
    },
    retainDeviceExecutionLock: async () => {},
    throwIfCanceled: () => {},
    contextFromFlags: () => ({ logPath: '/tmp/agent-device-request-chain.log' }),
  };
}

test('route owner files match the production module loaders', () => {
  const source = fs.readFileSync(new URL('./request-handler-chain.ts', import.meta.url), 'utf8');
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
  // The loaders are relative to the chain module, which lives in a layer folder; resolve them
  // the same way the runtime does instead of assuming the package root.
  const CHAIN_DIR = 'packages/daemon/src/sessions/';
  for (const [, route, modulePath] of definitions) {
    assert.ok(route && modulePath);
    assert.equal(
      ownerFiles[route as keyof typeof ownerFiles],
      path.posix.normalize(`${CHAIN_DIR}${modulePath}`),
    );
  }
  assert.ok(genericModulePath && genericRouteMatches);
  assert.equal(ownerFiles.generic, path.posix.normalize(`${CHAIN_DIR}${genericModulePath}`));

  assert.ok(
    !/ownerFile/.test(source),
    'owner-file paths are tooling-only: keep them in route-owner-files.ts, not the production chain module',
  );
});

test('request handler chain keeps interaction routes out of its eager import closure', () => {
  const chainFile = path.resolve(import.meta.dirname, './request-handler-chain.ts');
  const closure = eagerClosureOf(chainFile);

  assert.ok(closure.length > 20, 'eager closure walk must reach the request chain');
  assert.equal(
    closure.includes(path.resolve(import.meta.dirname, '../execution/interaction/index.ts')),
    false,
    'interaction routes must stay behind the request chain lazy import',
  );
});

test('interaction facade keeps route implementations out of its eager import closure', () => {
  const facadeFile = path.resolve(import.meta.dirname, '../execution/interaction/index.ts');
  const closure = eagerClosureOf(facadeFile);
  const snapshotComposition = path.resolve(
    import.meta.dirname,
    '../core/snapshot-runtime-capture-input.ts',
  );

  assert.ok(
    closure.includes(snapshotComposition),
    'interaction facade eager closure must include its snapshot composition dependency',
  );

  for (const routeModule of ['find.ts', 'interaction.ts']) {
    const routePath = path.resolve(
      import.meta.dirname,
      `../execution/interaction/internal/${routeModule}`,
    );
    assert.equal(
      fs.existsSync(routePath),
      true,
      `${routeModule} must exist for this closure check`,
    );
    assert.equal(
      closure.includes(routePath),
      false,
      `${routeModule} must stay behind the interaction facade's deferred delegate`,
    );
  }
});

test('request handler chain routes trace commands to the record-trace family', async () => {
  const response = await runRequestHandlerChain(makeChainParams(makeRequest('trace', ['start'])));

  assert.equal(response?.ok, true);
  assert.equal(response?.data?.trace, 'started');
});

test('request handler chain forwards the deferred provider app catalog to inventory', async () => {
  const req = makeRequest('apps');
  req.flags = { platform: 'android', leaseProvider: 'limrun' };
  const response = await runRequestHandlerChain({
    ...makeChainParams(req),
    providerAppCatalog: {
      supports: (provider) => provider === 'limrun',
      list: async () => ['Example.apk'],
    },
  });

  assert.deepEqual(response, { ok: true, data: { apps: ['Example.apk'] } });
});

// R61 put `react-native dismiss-overlay` behind the owner's own `tapPoint` admission, and the
// chain had never forwarded the request's runtime bindings to that route — so the dismissal leg
// had been reaching a missing gateway ever since R48 moved it off the retired dispatcher. Only
// the no-overlay path returned early enough to hide it, which is why no suite caught it.
test('request handler chain forwards the request runtime bindings to react-native', async () => {
  const inspected: string[] = [];
  const params = makeChainParams(makeRequest('react-native', ['dismiss-overlay']));

  const response = await runRequestHandlerChain({
    ...params,
    inspectFacts: async (device) => {
      inspected.push(device.id);
      return await unavailableDeviceRuntimeGateway.inspectFacts(device);
    },
  });

  // The bindings reached the route, and the owner's refusal — not a missing gateway — is what
  // came back. A chain that dropped them would answer `runtime-gateway-missing` instead.
  assert.equal(inspected.length, 1);
  assert.equal(response?.ok, false);
  if (response?.ok === false) {
    assert.match(response.error.message, /react-native dismiss-overlay is not supported/);
  }
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

test('duration-less coordinate swipe routes one fling plan through one runtime binding', async () => {
  const sessionStore = makeSessionStore('agent-device-linux-swipe-');
  sessionStore.publish('linux-swipe', makeSession('linux-swipe', { device: LINUX_DEVICE }));
  const commandSurface = createTouchCommandSurface({
    members: (config) => ({
      interactions: {
        gesture: async ({ session, requestId, gesture }) => {
          if (gesture.intent === 'drag') throw new Error('swipe must plan a fling');
          const context = { session, requestId };
          const viewport = await config.backend.resolveGestureViewport?.(context);
          if (!viewport) throw new Error('gesture viewport was not admitted');
          const plan = buildGesturePlan(gesture, viewport, 'linux');
          if (plan.topology !== 'single') throw new Error('swipe must plan one pointer');
          const backendResult = await config.backend.performGesture?.(context, plan);
          const { start, end } = singlePointerPlanEndpoints(plan);
          return {
            kind: plan.intent,
            durationMs: plan.durationMs,
            pointerCount: 1,
            from: start,
            to: end,
            ...backendResult,
          };
        },
      },
    }),
  });
  gestureRuntimeSpies.performGesturePlan.mockClear();
  const dispatchLedger = createRequestDispatchLedger();
  const gateway = gestureDeviceRuntimeGateway;
  const requestBindings = createRequestRuntimeBindings({
    gateway,
    dispatchLedger,
    scope: {
      signal: new AbortController().signal,
      diagnostics: { emit: () => {} },
      progress: { report: () => {} },
    },
    admitDeviceClaim: async () => {},
  });
  let bindCount = 0;
  const response = await handleInteractionCommands({
    createCommandSurface: commandSurface,
    platformServices: daemonPlatformServicesFixture(),
    inspectFacts: async (device) => await gestureInspectFacts(device),
    bindDevice: async (device, use) => {
      bindCount += 1;
      return await requestBindings.bindDevice(device, use);
    },
    req: {
      ...makeRequest('swipe'),
      session: 'linux-swipe',
      input: { from: { x: 10, y: 20 }, to: { x: 110, y: 20 } },
    },
    sessionName: 'linux-swipe',
    sessionStore,
    contextFromFlags: () => ({}),
    captureSnapshotForSession: async () => {
      throw new Error('the admitted gesture viewport should avoid capture fallback');
    },
  });

  assert.ok(response?.ok);
  assert.ok(response.data);
  assert.equal(response.data.kind, 'fling');
  assert.equal(bindCount, 1);
  assert.equal(gestureRuntimeSpies.performGesturePlan.mock.calls.length, 1);
  const call = gestureRuntimeSpies.performGesturePlan.mock.calls[0];
  assert.ok(call);
  const plan = call[0].plan;
  assert.equal(plan.topology, 'single');
  assert.equal(plan.intent, 'fling');
  assert.equal(plan.durationMs, 100);
  await requestBindings[Symbol.asyncDispose]();
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
