import { beforeEach, expect, test, vi } from 'vitest';

import { alertNotFound } from './launch-confirmation.fixtures.ts';
import { launchUrlSimulator, openInput, resetUrlOwner } from './lifecycle.fixtures.ts';

vi.mock('./core/app-resolution.ts', async () => {
  const fixtures = await import('./lifecycle.fixtures.ts');
  return {
    resolveIosSimulatorDeepLinkBundleId: async () => await fixtures.urlOwner.resolve(),
  };
});

const devClientLaunch = vi.hoisted(() => vi.fn<() => Promise<string | undefined>>());
const applyRuntimeHints = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('./expo-dev-client-launch.ts', () => ({ resolveExpoDevClientLaunchUrl: devClientLaunch }));

beforeEach(() => {
  resetUrlOwner();
  devClientLaunch.mockReset();
  applyRuntimeHints.mockReset();
});

const DEV_CLIENT_URL = 'exp+dev-slug://expo-development-client/?url=http%3A%2F%2F127.0.0.1%3A8085';
const METRO_HINTS = { metroHost: '127.0.0.1', metroPort: '8085' };

test.each([
  [
    'Expo development build',
    DEV_CLIENT_URL,
    { values: METRO_HINTS, apply: applyRuntimeHints },
    `open ${DEV_CLIENT_URL}`,
    0,
    1,
  ],
  [
    'bare React Native app',
    undefined,
    { values: METRO_HINTS, apply: applyRuntimeHints },
    'open',
    1,
    1,
  ],
  ['app without Metro hints', DEV_CLIENT_URL, undefined, 'open', 0, 0],
] as const)(
  '%s opens through the appropriate route',
  async (_, url, runtimeHints, event, prefs, probes) => {
    devClientLaunch.mockResolvedValue(url);
    const { lifecycle, events } = launchUrlSimulator(async () => {
      throw alertNotFound();
    });

    await lifecycle.openApplication({
      ...openInput(),
      runtimeHints,
      execution: { plannedOperations: ['captureSnapshot'] },
    });

    expect(devClientLaunch).toHaveBeenCalledTimes(probes);
    expect(applyRuntimeHints).toHaveBeenCalledTimes(prefs);
    expect(events.filter((entry) => entry.startsWith('open'))).toEqual([event]);
  },
);
