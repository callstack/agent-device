import { expect, test } from 'vitest';
import { daemonPlatformServicesFixture } from '../../../__tests__/support/platform-services-fixture.ts';
import { makeIosSession } from '../../../__tests__/support/session-factories.ts';
import { makeSessionStore } from '../../../__tests__/support/store-factory.ts';
import { touchCreateCommandSurface } from '../../../__tests__/support/touch-command-surface-fake.ts';
import { handleInteractionCommands } from '../index.ts';
import { gestureRuntimeBindingsFixture } from './__tests__/gesture-runtime-bindings.fixtures.ts';

const from = { x: 120, y: 220 };
const to = { x: 120, y: 320 };
const pan = { kind: 'pan', origin: from, delta: { x: 0, y: 100 }, durationMs: 500 };

test.each([
  { name: 'one-finger pan', command: 'gesture', input: pan, scope: 'including-keyboard' },
  { name: 'two-finger pan', command: 'gesture', input: { ...pan, pointerCount: 2 } },
  { name: 'fling', command: 'gesture', input: { kind: 'fling', direction: 'down', origin: from } },
  { name: 'swipe', command: 'swipe', input: { from, to } },
  {
    name: 'Split View exit',
    command: 'gesture',
    input: { kind: 'swipe', preset: 'split-view-exit' },
    scope: 'display',
  },
  {
    name: 'Maestro coordinate swipe',
    command: 'gesture',
    input: pan,
    internal: { gestureExecutionProfile: 'endpoint-hold' },
  },
] as const)('$name requests the appropriate iOS viewport', async (scenario) => {
  const sessionName = 'gesture-viewport';
  const sessionStore = makeSessionStore();
  sessionStore.publish(
    sessionName,
    makeIosSession(sessionName, { appBundleId: 'com.example.app' }),
  );
  const { gestureViewport, inspectFacts, bindDevice } = gestureRuntimeBindingsFixture();

  const response = await handleInteractionCommands({
    createCommandSurface: async (config) => {
      const surface = await touchCreateCommandSurface(config);
      return {
        ...surface,
        interactions: {
          ...surface.interactions,
          gesture: async (options) => {
            await config.backend.resolveGestureViewport?.({ session: sessionName });
            return await surface.interactions.gesture(options);
          },
        },
      };
    },
    platformServices: daemonPlatformServicesFixture(),
    req: {
      token: 't',
      session: sessionName,
      command: scenario.command,
      positionals: [],
      flags: {},
      input: scenario.input,
      ...('internal' in scenario ? { internal: scenario.internal } : {}),
    },
    sessionName,
    sessionStore,
    captureSnapshotForSession: async ({ session }) => session.snapshot!,
    contextFromFlags: () => ({}),
    inspectFacts,
    bindDevice,
  });

  expect(response).toMatchObject({ ok: true });
  expect(gestureViewport).toHaveBeenCalledOnce();
  expect(gestureViewport.mock.calls[0]?.[0].scope).toBe(
    'scope' in scenario ? scenario.scope : undefined,
  );
});

test('a held pan is admitted through the target-authored-drag tier and records holdMs', async () => {
  // With the plain plan cell unavailable, only a held pan can be admitted: the hold exists only in
  // intermediate plan samples, so it needs the tier whose fact promises hold-preserving execution.
  const run = async (input: Record<string, unknown>) => {
    const sessionName = `held-pan-${input.holdMs ?? 'none'}`;
    const sessionStore = makeSessionStore();
    const session = makeIosSession(sessionName, { appBundleId: 'com.example.app' });
    sessionStore.publish(sessionName, session);
    const gestures = gestureRuntimeBindingsFixture({ unavailable: ['performGesturePlan'] });
    const response = await handleInteractionCommands({
      createCommandSurface: touchCreateCommandSurface,
      platformServices: daemonPlatformServicesFixture(),
      req: {
        token: 't',
        session: sessionName,
        command: 'gesture',
        positionals: [],
        flags: {},
        input,
      },
      sessionName,
      sessionStore,
      captureSnapshotForSession: async ({ session: s }) => s.snapshot!,
      contextFromFlags: () => ({}),
      inspectFacts: gestures.inspectFacts,
      bindDevice: gestures.bindDevice,
    });
    return { response, session };
  };

  const held = await run({ ...pan, holdMs: 800 });
  expect(held.response).toMatchObject({ ok: true });
  expect(held.session.actions[0]?.flags).toMatchObject({ holdMs: 800 });

  const unheld = await run(pan);
  expect(unheld.response?.ok).toBe(false);
  if (unheld.response && !unheld.response.ok) {
    expect(unheld.response.error.code).toBe('UNSUPPORTED_OPERATION');
  }
});
