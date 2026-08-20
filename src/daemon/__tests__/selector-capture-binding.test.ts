import { expect, test } from 'vitest';
import { ANDROID_EMULATOR, IOS_SIMULATOR } from '../../__tests__/test-utils/device-fixtures.ts';
import {
  makeAndroidSession,
  makeIosSession,
} from '../../__tests__/test-utils/session-factories.ts';
import { makeSessionStore } from '../../__tests__/test-utils/store-factory.ts';
import { withTestDeviceInventory } from '../../__tests__/test-utils/device-inventory-gateways.ts';
import { resolveBoundSelectorCapture } from '../selector-capture-binding.ts';
import { createBoundSelectorRuntime } from '../selector-runtime-backend.ts';
import { selectorCaptureFixture } from './selector-capture-fixture.ts';

// The seam every selector unit consumes. `find` landed it; `get`, `is`, and `wait` migrate by
// naming their command, so these are the guarantees they inherit rather than re-derive.

test('an available plan inspects once and binds once, on the admitted device', async () => {
  const fixture = selectorCaptureFixture();

  const bound = await resolveBoundSelectorCapture({
    command: 'find',
    device: ANDROID_EMULATOR,
    session: makeAndroidSession('selector'),
    inspectFacts: fixture.inspectFacts,
    bindDevice: fixture.bindDevice,
  });

  expect(bound.ok).toBe(true);
  expect(fixture.inspections).toEqual([ANDROID_EMULATOR]);
  expect(fixture.binds).toEqual([ANDROID_EMULATOR]);
});

test('repeated captures reuse the one binding the plan was admitted for', async () => {
  const fixture = selectorCaptureFixture();
  const bound = await resolveBoundSelectorCapture({
    command: 'wait',
    device: ANDROID_EMULATOR,
    session: makeAndroidSession('selector'),
    inspectFacts: fixture.inspectFacts,
    bindDevice: fixture.bindDevice,
  });
  if (!bound.ok) throw new Error('expected an admitted capture');

  await bound.operations.capture({});
  await bound.operations.capture({});

  expect(fixture.binds).toEqual([ANDROID_EMULATOR]);
  expect(fixture.captures).toHaveLength(2);
});

test('an unavailable required operation refuses before any bind', async () => {
  const fixture = selectorCaptureFixture({
    capture: { available: false, reason: 'unsupported-platform-leaf' },
  });

  const bound = await resolveBoundSelectorCapture({
    command: 'is',
    device: ANDROID_EMULATOR,
    session: makeAndroidSession('selector'),
    inspectFacts: fixture.inspectFacts,
    bindDevice: fixture.bindDevice,
  });

  expect(bound).toMatchObject({ ok: false, response: { ok: false } });
  expect(fixture.binds).toEqual([]);
});

test.each(['find', 'get', 'is'] as const)(
  '%s ignores an advertised wait observation it does not execute',
  async (command) => {
    const fixture = selectorCaptureFixture({ findText: { available: true } });

    const bound = await resolveBoundSelectorCapture({
      command,
      device: ANDROID_EMULATOR,
      session: makeAndroidSession('selector'),
      inspectFacts: fixture.inspectFacts,
      bindDevice: fixture.bindDevice,
    });

    expect(bound.ok).toBe(true);
    expect(fixture.binds).toEqual([ANDROID_EMULATOR]);
  },
);

test('wait rejects an advertised observation with no implementation', async () => {
  const fixture = selectorCaptureFixture({ findText: { available: true } });

  await expect(
    resolveBoundSelectorCapture({
      command: 'wait',
      device: ANDROID_EMULATOR,
      session: makeAndroidSession('selector'),
      inspectFacts: fixture.inspectFacts,
      bindDevice: fixture.bindDevice,
    }),
  ).rejects.toMatchObject({ details: { reason: 'runtime-contract-invalid' } });
});

// The active-app split is the only plan axis selector commands have: no `--actions` surface,
// so `captureSnapshotWithCustomActions` is never required and never admitted for them.
test('a session without a tracked app selects the without-active-app plan', async () => {
  const fixture = selectorCaptureFixture({
    withoutActiveApp: { available: false, reason: 'owner-capability-missing' },
  });

  const withApp = await resolveBoundSelectorCapture({
    command: 'get',
    device: IOS_SIMULATOR,
    session: makeIosSession('with-app', { appBundleId: 'com.example.app' }),
    inspectFacts: fixture.inspectFacts,
    bindDevice: fixture.bindDevice,
  });
  // The iOS refusal enriches its hint from device inventory, which request execution owns.
  const withoutApp = await withTestDeviceInventory(
    {},
    async () =>
      await resolveBoundSelectorCapture({
        command: 'get',
        device: IOS_SIMULATOR,
        session: makeIosSession('no-app'),
        inspectFacts: fixture.inspectFacts,
        bindDevice: fixture.bindDevice,
      }),
  );

  expect(withApp.ok).toBe(true);
  expect(withoutApp.ok).toBe(false);
});

// `createBoundSelectorRuntime` is the construction path `get`, `is`, and `wait` switch onto:
// admit, bind once, then build the selector runtime with the bound operations attached. It is
// exercised here rather than from a command route because no selector descriptor has cut over
// yet — `find`'s own cutover is deferred behind the Wave 5 `focus`/`type` surfaces.
test('the bound construction path admits and binds before it builds a runtime', async () => {
  const fixture = selectorCaptureFixture();
  const sessionStore = makeSessionStore();
  sessionStore.set('bound', makeAndroidSession('bound'));

  const resolved = await createBoundSelectorRuntime(
    {
      req: { token: 't', session: 'bound', command: 'get', positionals: [], flags: {} },
      sessionName: 'bound',
      logPath: '/tmp/bound.log',
      sessionStore,
      inspectFacts: fixture.inspectFacts,
      bindDevice: fixture.bindDevice,
    },
    { requireSession: true, command: 'get' },
  );

  expect(resolved.ok).toBe(true);
  expect(fixture.inspections).toEqual([ANDROID_EMULATOR]);
  expect(fixture.binds).toEqual([ANDROID_EMULATOR]);
});

test('the bound construction path refuses an unavailable operation without building a runtime', async () => {
  const fixture = selectorCaptureFixture({
    capture: { available: false, reason: 'unsupported-platform-leaf' },
  });
  const sessionStore = makeSessionStore();
  sessionStore.set('bound', makeAndroidSession('bound'));

  const resolved = await createBoundSelectorRuntime(
    {
      req: { token: 't', session: 'bound', command: 'is', positionals: [], flags: {} },
      sessionName: 'bound',
      logPath: '/tmp/bound.log',
      sessionStore,
      inspectFacts: fixture.inspectFacts,
      bindDevice: fixture.bindDevice,
    },
    { requireSession: true, command: 'is' },
  );

  expect(resolved).toMatchObject({ ok: false, response: { ok: false } });
  expect(fixture.binds).toEqual([]);
});
