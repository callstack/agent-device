import { expect, test, vi } from 'vitest';
import type { PlatformRuntimeHost } from '@agent-device/contracts/platform-runtime-operations';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { platformRuntimeHostFixture } from './runtime.fixtures.ts';
import { bindAppleFindTextRuntime } from './runtime-snapshot.ts';

const ios = {
  platform: 'apple',
  appleOs: 'ios',
  id: 'ios',
  name: 'iOS',
  kind: 'simulator',
  target: 'mobile',
  booted: true,
} as const satisfies DeviceInfo;

test('findText resolves the owner interactor once with request execution and cancellation', async () => {
  const findText = vi.fn(
    async (_text: string, _options?: { appBundleId?: string; signal?: AbortSignal }) => ({
      found: true,
    }),
  );
  const resolve = vi.fn(async () => ({ findText }) as never);
  // A live runner keeps answering natively; only an absent one defers to the canonical tree.
  const host = hostWithRunner(true, resolve);
  const request = new AbortController();
  const poll = new AbortController();
  const operation = bindAppleFindTextRuntime(host, { device: ios, signal: request.signal });

  await expect(
    operation.findText({
      text: 'submit',
      options: { appBundleId: 'com.example.app', surface: 'app' },
      execution: { requestId: 'request-1' },
      signal: poll.signal,
    }),
  ).resolves.toEqual({ found: true });

  expect(resolve).toHaveBeenCalledOnce();
  expect(resolve).toHaveBeenCalledWith(
    ios,
    expect.objectContaining({ appBundleId: 'com.example.app', requestId: 'request-1' }),
  );
  expect(findText).toHaveBeenCalledWith(
    'submit',
    expect.objectContaining({ appBundleId: 'com.example.app', signal: expect.any(AbortSignal) }),
  );
  const signal = findText.mock.calls[0]?.[1]?.signal;
  poll.abort(new DOMException('poll ended', 'AbortError'));
  expect(signal?.aborted).toBe(true);
});

test.each([
  ['no active app', ios, undefined, undefined],
  [
    'non-app macOS surface',
    { ...ios, appleOs: 'macos', kind: 'device', target: 'desktop' } as const,
    'com.example.app',
    'desktop' as const,
  ],
])(
  'findText declines %s without resolving an interactor',
  async (_name, device, appBundleId, surface) => {
    const resolve = vi.fn(async () => ({}) as never);
    const host = { ...platformRuntimeHostFixture(), localInteractors: { resolve } };
    const operation = bindAppleFindTextRuntime(host, {
      device,
      signal: new AbortController().signal,
    });

    await expect(
      operation.findText({
        text: 'Settings',
        options: { ...(appBundleId ? { appBundleId } : {}), ...(surface ? { surface } : {}) },
      }),
    ).resolves.toEqual({ found: false });
    expect(resolve).not.toHaveBeenCalled();
  },
);

function hostWithRunner(
  alive: boolean,
  resolve: PlatformRuntimeHost['localInteractors']['resolve'],
): PlatformRuntimeHost {
  const base = platformRuntimeHostFixture();
  return {
    ...base,
    localInteractors: { resolve },
    appleApplications: { ...base.appleApplications, hasLiveRunnerSession: async () => alive },
  };
}

test('findText on a Simulator without a live runner reports not-proven', async () => {
  const resolve = vi.fn(async () => ({}) as never);
  const operation = bindAppleFindTextRuntime(hostWithRunner(false, resolve), {
    device: ios,
    signal: new AbortController().signal,
  });
  await expect(
    operation.findText({ text: 'Settings', options: { appBundleId: 'com.example.app' } }),
  ).resolves.toEqual({ found: false });
  expect(resolve).not.toHaveBeenCalled();
});

test('findText on a Simulator with a live runner still asks the runner', async () => {
  const findText = vi.fn(async () => ({ found: true }));
  const resolve = vi.fn(async () => ({ findText }) as never);
  const operation = bindAppleFindTextRuntime(hostWithRunner(true, resolve), {
    device: ios,
    signal: new AbortController().signal,
  });

  await expect(
    operation.findText({ text: 'Settings', options: { appBundleId: 'com.example.app' } }),
  ).resolves.toEqual({ found: true });
  expect(resolve).toHaveBeenCalledOnce();
});

test('findText on a physical iOS device resolves the runner regardless of session liveness', async () => {
  const findText = vi.fn(async () => ({ found: true }));
  const resolve = vi.fn(async () => ({ findText }) as never);
  const device = { ...ios, kind: 'device' } as const satisfies DeviceInfo;
  const operation = bindAppleFindTextRuntime(hostWithRunner(false, resolve), {
    device,
    signal: new AbortController().signal,
  });

  await expect(
    operation.findText({ text: 'Settings', options: { appBundleId: 'com.example.app' } }),
  ).resolves.toEqual({ found: true });
  expect(resolve).toHaveBeenCalledOnce();
});
