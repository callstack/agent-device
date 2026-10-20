import { beforeEach, expect, test } from 'vitest';
import {
  makeIosSession,
  authoringPublication,
} from '../../../__tests__/support/session-factories.ts';
import { makeSessionStore } from '../../../__tests__/support/store-factory.ts';
import { daemonPlatformServicesFixture } from '../../../__tests__/support/platform-services-fixture.ts';
import { touchCreateCommandSurface } from '../../../__tests__/support/touch-command-surface-fake.ts';
import { handleInteractionCommands } from '../index.ts';
import { gestureRuntimeBindingsFixture } from './__tests__/gesture-runtime-bindings.fixtures.ts';

let gestures = gestureRuntimeBindingsFixture();

beforeEach(() => {
  gestures = gestureRuntimeBindingsFixture();
});

async function runGesture(input: Record<string, unknown>) {
  const sessionStore = makeSessionStore();
  const session = makeIosSession('tap', {
    appBundleId: 'com.example.tap',
    scriptPublication: authoringPublication('armed'),
  });
  sessionStore.publish('tap', session);
  const response = await handleInteractionCommands({
    createCommandSurface: touchCreateCommandSurface,
    platformServices: daemonPlatformServicesFixture(),
    req: {
      token: 't',
      session: 'tap',
      command: 'gesture',
      positionals: [],
      flags: {},
      input,
    },
    sessionName: 'tap',
    sessionStore,
    captureSnapshotForSession: async ({ session: ref }) => ref.snapshot!,
    contextFromFlags: () => ({}),
    inspectFacts: gestures.inspectFacts,
    bindDevice: gestures.bindDevice,
  });
  return { response, action: session.actions[0] };
}

test('a structured tap series records its contacts and series flags for .ad replay', async () => {
  const { response, action } = await runGesture({
    kind: 'tap',
    points: [
      { x: 80, y: 300 },
      { x: 200, y: 450 },
    ],
    holdMs: 40,
    count: 2,
    pauseMs: 10,
  });

  expect(response?.ok).toBe(true);
  expect(action).toMatchObject({
    command: 'gesture',
    positionals: ['tap', '80', '300', '200', '450'],
    flags: { holdMs: 40, count: 2, pauseMs: 10 },
  });
});

test('a tap without series inputs records no series flags', async () => {
  const { action } = await runGesture({
    kind: 'tap',
    points: [
      { x: 80, y: 300 },
      { x: 200, y: 450 },
    ],
  });

  expect(action?.flags).not.toHaveProperty('count');
  expect(action?.flags).not.toHaveProperty('holdMs');
  expect(action?.flags).not.toHaveProperty('pauseMs');
});
