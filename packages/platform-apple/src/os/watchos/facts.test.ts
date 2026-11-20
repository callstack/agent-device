import { bindTestCommandHost } from '@agent-device/test-kit';
import { expect, test } from 'vitest';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { createApplePlatformRuntime } from '../../runtime.ts';
import { platformRuntimeHostFixture } from '../../runtime.fixtures.ts';
import { WATCH_OS_MULTI_TOUCH_UNSUPPORTED_HINT } from './facts.ts';

bindTestCommandHost();

function watch(kind: DeviceInfo['kind'] = 'simulator'): DeviceInfo {
  return {
    platform: 'apple',
    appleOs: 'watchos',
    id: 'watch',
    name: 'Apple Watch',
    kind,
    target: 'mobile',
    booted: true,
  };
}

async function availableOperations(device: DeviceInfo): Promise<string[]> {
  const facts = await createApplePlatformRuntime(platformRuntimeHostFixture()).inspectFacts(device);
  return Object.entries(facts.operations)
    .filter(([, fact]) => fact.available)
    .map(([operation]) => operation)
    .sort();
}

test('a watchOS simulator admits only the operations with a watch meaning', async () => {
  expect(await availableOperations(watch())).toEqual(
    [
      'actionButton',
      'appState',
      'back',
      'bootTarget',
      'captureScreenshot',
      'captureSnapshot',
      'closeApplication',
      'deployApp',
      'deployMaterializedApp',
      'ensureReady',
      'fillPoint',
      'finalizeApplicationClose',
      'findText',
      'focusPoint',
      'gestureViewport',
      'home',
      'longPressPoint',
      'materializeAppSource',
      'openApplication',
      'performDirectionalFlingPlan',
      'performGesturePlan',
      'prepareAppleRunner',
      'prepareApplicationOpen',
      'querySelector',
      'readTextAtPoint',
      'resolveOpenTarget',
      'screenRecordingCleanup',
      'screenRecordingReattach',
      'screenRecordingStart',
      'scrollDirection',
      'shutdownTarget',
      'tapElementSelector',
      'tapPoint',
      'typeText',
      'uninstallApp',
    ].sort(),
  );
});

test('a watchOS simulator names why it refuses multi-touch and the App Switcher', async () => {
  const facts = await createApplePlatformRuntime(platformRuntimeHostFixture()).inspectFacts(
    watch(),
  );
  expect(facts.operations.performMultiTouchGesturePlan).toEqual({
    available: false,
    reason: 'unsupported-platform-leaf',
    hint: WATCH_OS_MULTI_TOUCH_UNSUPPORTED_HINT,
  });
  expect(facts.operations.appSwitcher).toMatchObject({
    available: false,
    hint: expect.stringContaining('Digital Crown double-click'),
  });
});

test('a watchOS simulator binds exactly the operations its facts admit', async () => {
  const binding = await createApplePlatformRuntime(platformRuntimeHostFixture()).bind({
    device: watch(),
    intent: { kind: 'ordinary' },
    scope: {
      signal: new AbortController().signal,
      diagnostics: { emit: () => {} },
      progress: { report: () => {} },
    },
  });
  for (const [operation, fact] of Object.entries(binding.facts.operations)) {
    expect(typeof (binding.operations as Record<string, unknown>)[operation], operation).toBe(
      fact.available ? 'function' : 'undefined',
    );
  }
});

test('a physical Apple Watch is refused on every operation', async () => {
  expect(await availableOperations(watch('device'))).toEqual([]);
});
