import { expect, test, vi } from 'vitest';

const loads = vi.hoisted(() => ({ android: 0, harmonyos: 0 }));

vi.mock('./platforms/android/app-lifecycle.ts', () => {
  loads.android += 1;
  return {
    getAndroidAppState: async () => ({
      package: 'com.example.android',
      activity: '.MainActivity',
    }),
  };
});

vi.mock('./platforms/harmonyos/app-lifecycle.ts', () => {
  loads.harmonyos += 1;
  return {
    getHarmonyAppState: async () => ({
      package: 'com.example.harmony',
      activity: 'MainAbility',
    }),
  };
});

import { createAppStateRuntimeHost } from './platform-runtime-app-state-host.ts';

test('keeps foreground-state implementations lazy until the selected leaf executes', async () => {
  const host = createAppStateRuntimeHost();
  const signal = new AbortController().signal;
  const android = {
    platform: 'android' as const,
    id: 'emulator-5554',
    name: 'Pixel',
    kind: 'emulator' as const,
  };
  const harmony = {
    platform: 'harmonyos' as const,
    id: 'harmony-1',
    name: 'Harmony',
    kind: 'device' as const,
  };

  expect(loads).toEqual({ android: 0, harmonyos: 0 });
  await expect(host.android.appState(android, signal)).resolves.toEqual({
    package: 'com.example.android',
    activity: '.MainActivity',
  });
  expect(loads).toEqual({ android: 1, harmonyos: 0 });

  await expect(host.harmonyos.appState(harmony, signal)).resolves.toEqual({
    package: 'com.example.harmony',
    activity: 'MainAbility',
  });
  expect(loads).toEqual({ android: 1, harmonyos: 1 });
});
