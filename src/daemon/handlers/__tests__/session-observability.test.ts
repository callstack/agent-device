import assert from 'node:assert/strict';
import { test } from 'vitest';
import { makeAndroidSession } from '../../../__tests__/test-utils/session-factories.ts';
import { makeSessionStore } from '../../../__tests__/test-utils/store-factory.ts';
import { handleSessionObservabilityCommands } from '../session-observability.ts';
import { createNetworkRuntime, emptyAppLogResult } from './network-runtime-harness.ts';

test('network dump validates include mode directly', async () => {
  const sessionStore = makeAndroidStore();
  const session = sessionStore.get('android');
  assert.ok(session);
  const runtime = createNetworkRuntime(session.device, async (input) =>
    emptyAppLogResult('android', input),
  );
  const response = await handleSessionObservabilityCommands({
    req: {
      token: 't',
      session: 'android',
      command: 'network',
      positionals: ['dump', '5', 'invalid-mode'],
      flags: {},
    },
    sessionName: 'android',
    sessionStore,
    bindDevice: runtime.bindDevice,
  });

  assert.equal(response?.ok, false);
  if (response && !response.ok) {
    assert.equal(response.error.code, 'INVALID_ARGS');
    assert.match(response.error.message, /network include mode must be one of/i);
  }
});

test('network dump accepts explicit include flag and rejects conflicting values', async () => {
  const sessionStore = makeAndroidStore();
  const session = sessionStore.get('android');
  assert.ok(session);
  const runtime = createNetworkRuntime(session.device, async (input) =>
    emptyAppLogResult('android', input),
  );
  const okResponse = await handleSessionObservabilityCommands({
    req: {
      token: 't',
      session: 'android',
      command: 'network',
      positionals: ['dump', '5'],
      flags: { networkInclude: 'headers' },
    },
    sessionName: 'android',
    sessionStore,
    bindDevice: runtime.bindDevice,
  });
  assert.equal(okResponse?.ok, true);
  if (okResponse?.ok) assert.equal(okResponse.data?.include, 'headers');

  const conflictResponse = await handleSessionObservabilityCommands({
    req: {
      token: 't',
      session: 'android',
      command: 'network',
      positionals: ['dump', '5', 'summary'],
      flags: { networkInclude: 'headers' },
    },
    sessionName: 'android',
    sessionStore,
    bindDevice: runtime.bindDevice,
  });
  assert.equal(conflictResponse?.ok, false);
  if (conflictResponse && !conflictResponse.ok) {
    assert.equal(conflictResponse.error.code, 'INVALID_ARGS');
    assert.match(conflictResponse.error.message, /both positionally and via --include/i);
  }
});

const REMOVED_AGGREGATE_PERF_POSITIONALS: readonly string[][] = [
  [],
  ['metrics'],
  ['sample'],
  ['snapshot'],
  ['start'],
  ['stop'],
  ['report'],
];

test.each(REMOVED_AGGREGATE_PERF_POSITIONALS.map((positionals) => [positionals] as const))(
  'daemon rejects removed aggregate perf positionals %j with migration guidance',
  async (positionals) => {
    const sessionStore = makeAndroidStore();
    const response = await handleSessionObservabilityCommands({
      req: { token: 't', session: 'android', command: 'perf', positionals, flags: {} },
      sessionName: 'android',
      sessionStore,
    });
    assert.equal(response?.ok, false);
    if (response && !response.ok) {
      assert.equal(response.error.code, 'INVALID_ARGS');
      assert.match(response.error.message, /Aggregate perf was removed/);
      assert.match(response.error.message, /perf frames/);
      assert.match(response.error.message, /perf memory sample/);
    }
  },
);

function makeAndroidStore() {
  const sessionStore = makeSessionStore('agent-device-session-observability-');
  sessionStore.set('android', makeAndroidSession('android', { appBundleId: 'com.example.app' }));
  return sessionStore;
}
