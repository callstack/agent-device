import { expect, test } from 'vitest';
import { createAppleInteractor } from '../interactor.ts';
import { MACOS_DEVICE } from './device-fixtures.ts';
import { bindMacOsLeafFixture } from './macos-leaf.fixtures.ts';

const nativeHost = { env: { AGENT_DEVICE_MACOS_APP_BACKEND: 'native' }, cwd: process.cwd() };

test('the native backend interactor takes its actions from the installed leaf and offers no runner-only member', async () => {
  const leaf = bindMacOsLeafFixture({
    nativeAppActions: async () => ({ tap: async () => ({ mechanism: 'ax-press' }) }) as never,
  });
  const context = { appBundleId: 'com.apple.TextEdit' };
  const interactor = createAppleInteractor(MACOS_DEVICE, context, nativeHost);

  // Assembled member by member: what only the XCTest runner serves is absent, not refused late.
  expect(interactor.gestureViewport).toBeUndefined();
  expect(interactor.doubleTap).toBeUndefined();
  expect(interactor.findText).toBeUndefined();
  // Building the interactor asks the leaf nothing; the action does.
  expect(leaf.calls).toEqual([]);

  await expect(interactor.tap(10, 20)).resolves.toEqual({ mechanism: 'ax-press' });
  expect(leaf.calls).toHaveLength(1);
  expect(leaf.calls[0]).toMatchObject({ operation: 'nativeAppActions' });
  expect(leaf.calls[0]?.args.slice(1)).toEqual([context, nativeHost.env]);
});

test('the XCTest backend interactor keeps its runner members', () => {
  const interactor = createAppleInteractor(MACOS_DEVICE, {}, { env: {}, cwd: process.cwd() });
  expect(interactor.findText).toBeTypeOf('function');
});
