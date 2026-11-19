import { afterEach, expect, test, vi } from 'vitest';
import type {
  OpenApplicationInput,
  OpenApplicationRuntimeHints,
} from '@agent-device/contracts/application-lifecycle-runtime';
import { AppError, createRequestCanceledError } from '@agent-device/kernel/errors';
import { openInput as lifecycleOpenInput, simulator as SIMULATOR } from './lifecycle.fixtures.ts';

vi.mock('./core/app-resolution.ts', () => ({
  resolveIosSimulatorExpoDevClientScheme: vi.fn(),
}));

import { resolveIosSimulatorExpoDevClientScheme } from './core/app-resolution.ts';
import { resolveExpoDevClientLaunchUrl } from './expo-dev-client-launch.ts';

const resolveScheme = vi.mocked(resolveIosSimulatorExpoDevClientScheme);

function hints(values: Record<string, string>): OpenApplicationRuntimeHints {
  return { values, apply: async () => {} };
}

function openInput(overrides: Partial<OpenApplicationInput> = {}): OpenApplicationInput {
  return {
    ...lifecycleOpenInput(),
    runtimeHints: hints({ metroHost: '127.0.0.1', metroPort: '8085' }),
    ...overrides,
  };
}

afterEach(() => vi.clearAllMocks());

test.each([
  [
    'an http server',
    undefined,
    'exp+dev-slug://expo-development-client/?url=http%3A%2F%2F127.0.0.1%3A8085',
  ],
  [
    'an https server',
    'https://metro.example.test',
    'exp+dev-slug://expo-development-client/?url=https%3A%2F%2Fmetro.example.test',
  ],
])('points an expo-dev-client at %s', async (_name, bundleUrl, expected) => {
  resolveScheme.mockResolvedValue('exp+dev-slug');

  const input = openInput(bundleUrl ? { runtimeHints: hints({ bundleUrl }) } : {});
  await expect(resolveExpoDevClientLaunchUrl(SIMULATOR, input)).resolves.toBe(expected);
  expect(resolveScheme).toHaveBeenCalledWith(SIMULATOR, 'com.example.app', {
    timeoutMs: 3_000,
  });
});

test('points at the server origin of a bundle URL, not at the bundle itself', async () => {
  resolveScheme.mockResolvedValue('exp+dev-slug');
  const input = openInput({
    runtimeHints: hints({
      bundleUrl: 'http://10.0.0.5:8090/.expo/.virtual-metro-entry.bundle?platform=ios&dev=true',
    }),
  });

  await expect(resolveExpoDevClientLaunchUrl(SIMULATOR, input)).resolves.toBe(
    'exp+dev-slug://expo-development-client/?url=http%3A%2F%2F10.0.0.5%3A8090',
  );
});

test('keeps a single pair of brackets around an IPv6 bundle URL host', async () => {
  resolveScheme.mockResolvedValue('exp+dev-slug');
  const input = openInput({
    runtimeHints: hints({ bundleUrl: 'http://[::1]:8090/index.bundle?platform=ios' }),
  });

  await expect(resolveExpoDevClientLaunchUrl(SIMULATOR, input)).resolves.toBe(
    'exp+dev-slug://expo-development-client/?url=http%3A%2F%2F%5B%3A%3A1%5D%3A8090',
  );
});

test('keeps the server mount when opening a path-prefixed Expo bundle', async () => {
  resolveScheme.mockResolvedValue('exp+dev-slug');
  const input = openInput({
    runtimeHints: hints({
      bundleUrl:
        'https://metro.example.test/tenant-42/.expo/.virtual-metro-entry.bundle?platform=ios',
    }),
  });

  const launchUrl = await resolveExpoDevClientLaunchUrl(SIMULATOR, input);
  expect(new URL(launchUrl!).searchParams.get('url')).toBe('https://metro.example.test/tenant-42');
});

test.each([
  ['a bare React Native app', openInput(), undefined],
  [
    'an explicit --launch-url',
    openInput({ runtimeLaunchUrl: 'myapp://deep/link' }),
    'exp+dev-slug',
  ],
  ['an open without an app bundle id', openInput({ appBundleId: undefined }), 'exp+dev-slug'],
  ['hints without a host and port', openInput({ runtimeHints: hints({}) }), 'exp+dev-slug'],
])('keeps the plain launch for %s', async (_name, input, scheme) => {
  resolveScheme.mockResolvedValue(scheme);

  await expect(resolveExpoDevClientLaunchUrl(SIMULATOR, input)).resolves.toBeUndefined();
});

test('keeps the plain launch when the scheme probe fails', async () => {
  resolveScheme.mockRejectedValue(new AppError('COMMAND_FAILED', 'xcrun timed out'));

  await expect(resolveExpoDevClientLaunchUrl(SIMULATOR, openInput())).resolves.toBeUndefined();
});

test('propagates a canceled request instead of falling back', async () => {
  const canceled = createRequestCanceledError();
  resolveScheme.mockRejectedValue(canceled);

  await expect(resolveExpoDevClientLaunchUrl(SIMULATOR, openInput())).rejects.toBe(canceled);
});
